// Tesla Navi Realtime Communication Engine (Supabase Broadcast + Local WebSocket Fallback)

class TeslaRealtime {
  constructor(options = {}) {
    this.code = (options.code || this.generateRoomCode()).toUpperCase();
    this.role = options.role || 'display'; // 'display' | 'phone'
    this.onGpsUpdate = options.onGpsUpdate || (() => {});
    this.onDestinationSet = options.onDestinationSet || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    
    this.supabaseClient = null;
    this.supabaseChannel = null;
    this.localWs = null;
    this.isConnected = false;
    this.lastPacketTime = 0;
    this.heartbeatTimer = null;
  }

  // Generates 6-character easy-to-read room code (e.g. 24W84Z)
  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Removed confusing 0, O, 1, I
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Initialize both Supabase Broadcast and Local WebSocket
  init() {
    const channelName = `pair-${this.code.toLowerCase()}`;

    // 1. Initialize Supabase Realtime Broadcast if available
    try {
      if (window.supabase && CONFIG.supabase.url && CONFIG.supabase.anonKey) {
        this.supabaseClient = window.supabase.createClient(
          CONFIG.supabase.url,
          CONFIG.supabase.anonKey,
          { realtime: { params: { eventsPerSecond: 10 } } }
        );

        this.supabaseChannel = this.supabaseClient.channel(channelName, {
          config: { broadcast: { self: false } }
        });

        this.supabaseChannel
          .on('broadcast', { event: 'gps_update' }, ({ payload }) => {
            this.handleGpsPacket(payload);
          })
          .on('broadcast', { event: 'destination_set' }, ({ payload }) => {
            this.handleDestinationPacket(payload);
          })
          .on('broadcast', { event: 'ping' }, ({ payload }) => {
            this.handlePing(payload);
          })
          .subscribe((status) => {
            console.log(`[Supabase Realtime] ${channelName} status:`, status);
            if (status === 'SUBSCRIBED') {
              this.setConnected(true);
              this.sendPing();
            }
          });
      }
    } catch (err) {
      console.warn('[Supabase Realtime] initialization warning:', err);
    }

    // 2. Initialize Local WebSocket Fallback
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=${this.code.toLowerCase()}`;
      this.localWs = new WebSocket(wsUrl);

      this.localWs.onopen = () => {
        console.log('[Local WS] Connected to room:', this.code);
        this.setConnected(true);
        this.sendPing();
      };

      this.localWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === 'gps_update') this.handleGpsPacket(msg.payload);
          else if (msg.event === 'destination_set') this.handleDestinationPacket(msg.payload);
          else if (msg.event === 'ping') this.handlePing(msg.payload);
        } catch (e) {
          console.error('[Local WS] parse error:', e);
        }
      };

      this.localWs.onclose = () => {
        console.log('[Local WS] Connection closed');
      };
    } catch (e) {
      console.warn('[Local WS] Fallback not reachable:', e);
    }

    // Start heartbeat monitor
    this.startHeartbeatWatcher();
  }

  // Send GPS packet from Phone to Tesla Display
  sendGps(data) {
    const packet = {
      lat: data.lat,
      lng: data.lng,
      heading: data.heading || 0,
      speed: data.speed || 0,
      accuracy: data.accuracy || 10,
      timestamp: Date.now()
    };

    // Send via Supabase Broadcast
    if (this.supabaseChannel) {
      this.supabaseChannel.send({
        type: 'broadcast',
        event: 'gps_update',
        payload: packet
      });
    }

    // Send via Local WS
    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(JSON.stringify({ event: 'gps_update', payload: packet }));
    }
  }

  // Send destination from Phone to Tesla Display
  sendDestination(dest) {
    const packet = {
      name: dest.name || 'Destination',
      lat: dest.lat,
      lng: dest.lng,
      timestamp: Date.now()
    };

    if (this.supabaseChannel) {
      this.supabaseChannel.send({
        type: 'broadcast',
        event: 'destination_set',
        payload: packet
      });
    }

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(JSON.stringify({ event: 'destination_set', payload: packet }));
    }
  }

  sendPing() {
    const payload = { role: this.role, timestamp: Date.now() };
    if (this.supabaseChannel) {
      this.supabaseChannel.send({ type: 'broadcast', event: 'ping', payload });
    }
    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(JSON.stringify({ event: 'ping', payload }));
    }
  }

  handleGpsPacket(payload) {
    this.lastPacketTime = Date.now();
    this.setConnected(true);
    this.onGpsUpdate(payload);
  }

  handleDestinationPacket(payload) {
    this.lastPacketTime = Date.now();
    this.setConnected(true);
    this.onDestinationSet(payload);
  }

  handlePing(payload) {
    this.lastPacketTime = Date.now();
    this.setConnected(true);
  }

  setConnected(connected) {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      this.onStatusChange(connected);
    }
  }

  startHeartbeatWatcher() {
    this.heartbeatTimer = setInterval(() => {
      // If we haven't received a packet in 8 seconds and we are in display mode, mark connection lost
      if (this.role === 'display' && this.lastPacketTime > 0) {
        const elapsed = Date.now() - this.lastPacketTime;
        if (elapsed > 8000) {
          this.setConnected(false);
        }
      }
      this.sendPing();
    }, 4000);
  }
}
