import { useEffect, useState } from 'react';

export function useLiveUpdates(onEvent?: (event: string, payload: any) => void) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastPing, setLastPing] = useState<number>(Date.now());

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    function connect() {
      eventSource = new EventSource('/api/events/live');

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.onmessage = (e) => {
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
        setIsConnected(false);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        reconnectTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSource) eventSource.close();
    };
  }, []);

  return { isConnected, lastPing };
}
