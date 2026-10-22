/**
 * Vendoor Team Activity Deduplication & Canonical State Transition Engine
 *
 * Implements strict order-level state transition deduplication for Team Performance:
 * 1. Analyzes the complete order event timeline chronologically (event_timestamp ASC, id ASC).
 * 2. Deduplicates consecutive identical status transitions (e.g. burst logs in Vendoor for the same UI action).
 * 3. Chooses the authoritative event (preferring human CS actors with descriptive transition text over system/unattributed).
 * 4. Permits valid re-entry transitions (when an order changes to another status and later returns).
 * 5. Tags all events with `is_counted`, `is_duplicate_transition`, and `exclusion_reason` without mutating/deleting DB rows.
 */

export interface RawTeamEvent {
  id: number;
  actor_name: string | null;
  action_type: string;
  from_status: string | null;
  to_status: string | null;
  order_code: string | null;
  event_timestamp: string;
  is_system_actor?: number | boolean;
  raw_event_id?: number | null;
  source_hash?: string | null;
  raw_action_text?: string | null;
  [key: string]: any;
}

export interface ProcessedTeamEvent extends RawTeamEvent {
  is_counted: boolean;
  is_duplicate_transition: boolean;
  exclusion_reason?: string | null;
  authoritative_transition_id?: number;
}

export interface OrderStateSnapshot {
  lastKnownStatus: string | null;
  lastTransitionTimestamp: string | null;
  lastTransitionEventId: number | null;
  lastTransitionActor: string | null;
}

/**
 * Normalizes status names to avoid casing or whitespace mismatches.
 */
export function normalizeStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const s = status.trim();
  const lower = s.toLowerCase();
  if (lower === 'printed' || lower === 'مطبوع') return 'Printed';
  if (lower === 'pending' || lower === 'معلق') return 'Pending';
  if (lower === 'processing' || lower === 'قيد التجهيز') return 'Processing';
  if (lower === 'canceled' || lower === 'canceling' || lower === 'ملغي' || lower === 'ملغى') return 'Canceled';
  if (lower === 'new' || lower === 'جديد') return 'New';
  if (lower === 'delivered' || lower === 'تم التوصيل') return 'Delivered';
  if (lower === 'returned' || lower === 'مرتجع') return 'Returned';
  return s;
}

/**
 * Checks whether an actor name represents a human employee vs system/automated.
 */
export function isHumanActor(actorName: string | null | undefined, isSystemActorFlag?: number | boolean): boolean {
  if (isSystemActorFlag === 1 || isSystemActorFlag === true) return false;
  if (!actorName) return false;
  const lower = actorName.toLowerCase();
  if (lower.includes('system') || lower.includes('نظام') || lower.includes('تلقائي') || lower.includes('automation')) {
    return false;
  }
  return true;
}

/**
 * Computes difference in seconds between two ISO/Cairo timestamps.
 */
export function timeDifferenceInSeconds(t1: string, t2: string): number {
  const d1 = new Date(t1.replace(' ', 'T')).getTime();
  const d2 = new Date(t2.replace(' ', 'T')).getTime();
  if (isNaN(d1) || isNaN(d2)) return 999999;
  return Math.abs(Math.round((d2 - d1) / 1000));
}

/**
 * Deduplicates team events across all orders and returns annotated events.
 * Crucially operates at the GLOBAL order history level BEFORE filtering by actor.
 */
export function processAndDeduplicateTeamEvents(
  events: RawTeamEvent[],
  priorStatusMap?: Map<string, string>
): ProcessedTeamEvent[] {
  // 1. Sort stably by timestamp ASC, then by id ASC
  const sorted = [...events].sort((a, b) => {
    if (a.event_timestamp !== b.event_timestamp) {
      return a.event_timestamp.localeCompare(b.event_timestamp);
    }
    return (a.id || 0) - (b.id || 0);
  });

  // 2. Partition events by order_code for order-level timeline tracking
  const orderEventsMap = new Map<string, RawTeamEvent[]>();
  const generalEvents: RawTeamEvent[] = [];

  for (const ev of sorted) {
    const code = ev.order_code ? ev.order_code.trim().toLowerCase() : null;
    if (code) {
      let list = orderEventsMap.get(code);
      if (!list) {
        list = [];
        orderEventsMap.set(code, list);
      }
      list.push(ev);
    } else {
      generalEvents.push(ev);
    }
  }

  const resultMap = new Map<number, ProcessedTeamEvent>();

  // 3. Process order-level timelines
  for (const [code, orderEvents] of orderEventsMap.entries()) {
    let currentStatus: string | null = priorStatusMap?.get(code)
      ? normalizeStatus(priorStatusMap.get(code)!)
      : null;
    let lastTransitionCluster: {
      targetStatus: string;
      events: RawTeamEvent[];
      primaryTimestamp: string;
    } | null = null;

    // Helper to flush and designate the authoritative event in a cluster
    const finalizeCluster = (cluster: { targetStatus: string; events: RawTeamEvent[]; primaryTimestamp: string }) => {
      if (cluster.events.length === 0) return;

      // Rule: Find the best authoritative candidate:
      // 1. Human actor preferred over system/automated
      // 2. Has both from_status and to_status
      // 3. Earliest ID / primary
      let chosen = cluster.events[0];
      let bestScore = -1;

      for (const cand of cluster.events) {
        let score = 0;
        const human = isHumanActor(cand.actor_name, cand.is_system_actor);
        if (human) score += 100;
        if (cand.from_status && cand.to_status) score += 20;
        if (cand.raw_action_text && cand.raw_action_text.includes(cand.actor_name || '')) score += 10;
        if (score > bestScore) {
          bestScore = score;
          chosen = cand;
        }
      }

      // Mark chosen event as counted
      resultMap.set(chosen.id, {
        ...chosen,
        is_counted: true,
        is_duplicate_transition: false,
        exclusion_reason: null,
        authoritative_transition_id: chosen.id,
      });

      // Mark all other events in this duplicate cluster as excluded
      for (const cand of cluster.events) {
        if (cand.id !== chosen.id) {
          const isSameActor = cand.actor_name === chosen.actor_name;
          const reason = isSameActor
            ? 'DUPLICATE_SAME_BURST_EVENT'
            : 'DUPLICATE_TRANSITION_CROSS_ACTOR_COPY';
          resultMap.set(cand.id, {
            ...cand,
            is_counted: false,
            is_duplicate_transition: true,
            exclusion_reason: reason,
            authoritative_transition_id: chosen.id,
          });
        }
      }
    };

    for (let i = 0; i < orderEvents.length; i++) {
      const ev = orderEvents[i];

      // Non-status change actions on an order (e.g. edited address, added phone, note)
      if (ev.action_type !== 'status_change' || !ev.to_status) {
        // Strict conservative duplicate check:
        // Only classify as duplicate if exact identical source_hash OR exact same second timestamp with identical actor and raw_action_text
        const prev = i > 0 ? orderEvents[i - 1] : null;
        const isExactHashDuplicate = Boolean(
          prev && prev.source_hash && ev.source_hash && prev.source_hash === ev.source_hash
        );
        const isZeroSecondDuplicate = Boolean(
          prev &&
          prev.action_type === ev.action_type &&
          prev.actor_name === ev.actor_name &&
          prev.raw_action_text === ev.raw_action_text &&
          prev.event_timestamp === ev.event_timestamp
        );

        if (isExactHashDuplicate || isZeroSecondDuplicate) {
          resultMap.set(ev.id, {
            ...ev,
            is_counted: false,
            is_duplicate_transition: true,
            exclusion_reason: isExactHashDuplicate ? 'EXACT_SOURCE_HASH_DUPLICATE' : 'ZERO_SECOND_IDENTICAL_ACTION',
            authoritative_transition_id: prev!.id,
          });
        } else {
          resultMap.set(ev.id, {
            ...ev,
            is_counted: true,
            is_duplicate_transition: false,
            exclusion_reason: null,
            authoritative_transition_id: ev.id,
          });
        }
        continue;
      }

      const targetStatus = normalizeStatus(ev.to_status)!;
      const declaredFromStatus = normalizeStatus(ev.from_status);

      // Conservative burst grouping:
      // Group into the same transition cluster ONLY if:
      // 1. Same target status AND
      // 2. Either exact same timestamp (0s), identical source_hash, or sub-5-second rapid burst write
      // Never group or discard actions based on arbitrary 60-second windows alone
      const timeDiff = lastTransitionCluster
        ? timeDifferenceInSeconds(lastTransitionCluster.primaryTimestamp, ev.event_timestamp)
        : 999999;

      const isConfirmedBurst = Boolean(
        lastTransitionCluster &&
        lastTransitionCluster.targetStatus === targetStatus &&
        (
          timeDiff === 0 ||
          (ev.source_hash && lastTransitionCluster.events.some(e => e.source_hash === ev.source_hash)) ||
          (timeDiff <= 5 && (
            lastTransitionCluster.events.some(e => e.actor_name === ev.actor_name) ||
            !isHumanActor(ev.actor_name, ev.is_system_actor) ||
            lastTransitionCluster.events.some(e => !isHumanActor(e.actor_name, e.is_system_actor))
          ))
        )
      );

      if (isConfirmedBurst && lastTransitionCluster) {
        lastTransitionCluster.events.push(ev);
        continue;
      }

      // If we had an existing transition cluster and now see a different transition or distinct event, finalize it
      if (lastTransitionCluster) {
        finalizeCluster(lastTransitionCluster);
        currentStatus = lastTransitionCluster.targetStatus;
        lastTransitionCluster = null;
      }

      // If order is already in targetStatus, only exclude if it's an immediate duplicate within 5s of same status
      const prevOrderEv = i > 0 ? orderEvents[i - 1] : null;
      const isImmediateRedundantClick = Boolean(
        prevOrderEv &&
        normalizeStatus(prevOrderEv.to_status) === targetStatus &&
        timeDifferenceInSeconds(prevOrderEv.event_timestamp, ev.event_timestamp) <= 5 &&
        (prevOrderEv.actor_name === ev.actor_name || !isHumanActor(ev.actor_name, ev.is_system_actor))
      );

      if (currentStatus === targetStatus && isImmediateRedundantClick) {
        resultMap.set(ev.id, {
          ...ev,
          is_counted: false,
          is_duplicate_transition: true,
          exclusion_reason: 'IMMEDIATE_REDUNDANT_RECLICK',
          authoritative_transition_id: prevOrderEv?.id || ev.id,
        });
        continue;
      }

      // This is a new valid transition to targetStatus!
      // Start a cluster to collect any immediate burst duplicates for this transition
      lastTransitionCluster = {
        targetStatus,
        events: [ev],
        primaryTimestamp: ev.event_timestamp,
      };
    }

    // Flush any pending cluster at end of order history
    if (lastTransitionCluster) {
      finalizeCluster(lastTransitionCluster);
    }
  }

  // 4. Process general events without order_code
  for (let i = 0; i < generalEvents.length; i++) {
    const ev = generalEvents[i];
    const prev = i > 0 ? generalEvents[i - 1] : null;
    const isDuplicate =
      prev &&
      prev.actor_name === ev.actor_name &&
      prev.action_type === ev.action_type &&
      prev.raw_action_text === ev.raw_action_text &&
      timeDifferenceInSeconds(prev.event_timestamp, ev.event_timestamp) <= 5;

    resultMap.set(ev.id, {
      ...ev,
      is_counted: !isDuplicate,
      is_duplicate_transition: !!isDuplicate,
      exclusion_reason: isDuplicate ? 'DUPLICATE_GENERAL_ACTION' : null,
      authoritative_transition_id: isDuplicate ? prev!.id : ev.id,
    });
  }

  // 5. Return events in original input order or annotated order
  return events.map((ev) => resultMap.get(ev.id) || {
    ...ev,
    is_counted: true,
    is_duplicate_transition: false,
    exclusion_reason: null,
    authoritative_transition_id: ev.id,
  });
}
