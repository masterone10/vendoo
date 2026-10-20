import { useEffect, useState, useRef } from 'react';

export function useLiveUpdates(onEvent?: (event: string, payload: any) => void) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastPing, setLastPing] = useState<number>(Date.now());
  const retryDelayRef = useRef<number>(3000);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;

      try {
        eventSource = new EventSource('/api/events/live');

        eventSource.onopen = () => {
          if (!isMounted) return;
          setIsConnected(true);
          retryDelayRef.current = 3000; // Reset backoff on successful connect
        };

        eventSource.onmessage = (e) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(e.data);
            if (data.event === 'heartbeat') {
              setLastPing(Date.now());
            }
            if (onEvent) {
              onEvent(data.event, data.payload);
            }
          } catch (err) {
            console.error('Error parsing SSE message:', err);
          }
        };

        eventSource.onerror = () => {
          if (!isMounted) return;
          setIsConnected(false);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          // Exponential backoff to prevent tight reconnect loops during server reboots
          const currentDelay = retryDelayRef.current;
          retryDelayRef.current = Math.min(30000, currentDelay * 1.5);
          reconnectTimeout = setTimeout(connect, currentDelay);
        };
      } catch (err) {
        setIsConnected(false);
        reconnectTimeout = setTimeout(connect, 5000);
      }
    }

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSource) eventSource.close();
    };
  }, []);

  return { isConnected, lastPing };
}
