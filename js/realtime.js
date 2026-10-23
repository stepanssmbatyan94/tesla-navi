// Tesla Navi Realtime Communication Engine (Supabase Broadcast + Local WebSocket Fallback)

const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 15000;

// 6-character easy-to-read pairing code (e.g. 24W84Z), no confusable 0/O/1/I.
// The code is the only thing guarding a pairing channel, so use the CSPRNG; 32 symbols
// divide 256 evenly, so byte % 32 is unbiased.
const PAIRING_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generatePairingCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => PAIRING_CODE_CHARS[b % PAIRING_CODE_CHARS.length]).join('');
}

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

  generateRoomCode() {
    return generatePairingCode();
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
              if (this.role === 'phone') {
                this.setConnected(true);
              }
              this.sendPing();
            }
          });
      }
    } catch (err) {
      console.warn('[Supabase Realtime] initialization warning:', err);
    }

    // 2. Initialize Local WebSocket Fallback
    this.connectLocalWs();

    // Start heartbeat monitor
    this.startHeartbeatWatcher();
  }

  // Local WS with automatic reconnect: phones drop the socket on every cell handover
  // or screen lock, and without a retry the fallback channel stayed dead for good
  connectLocalWs() {
    clearTimeout(this.wsReconnectTimer);
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=${this.code.toLowerCase()}`;
      const ws = new WebSocket(wsUrl);
      this.localWs = ws;

      ws.onopen = () => {
        console.log('[Local WS] Connected to room:', this.code);
        this.wsReconnectDelay = WS_RECONNECT_MIN_MS;
        if (this.role === 'phone') {
          this.setConnected(true);
        }
        this.sendPing();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === 'gps_update') this.handleGpsPacket(msg.payload);
          else if (msg.event === 'destination_set') this.handleDestinationPacket(msg.payload);
          else if (msg.event === 'ping') this.handlePing(msg.payload);
        } catch (e) {
          console.error('[Local WS] parse error:', e);
        }
      };

      ws.onclose = () => {
        if (this.localWs !== ws) return; // superseded by a newer socket
        const delay = this.wsReconnectDelay || WS_RECONNECT_MIN_MS;
        console.log(`[Local WS] Connection closed, reconnecting in ${delay} ms`);
        this.wsReconnectDelay = Math.min(delay * 2, WS_RECONNECT_MAX_MS);
        this.wsReconnectTimer = setTimeout(() => this.connectLocalWs(), delay);
      };
    } catch (e) {
      console.warn('[Local WS] Fallback not reachable:', e);
    }
  }

  // Reconnect right away (e.g. when the phone tab becomes visible again)
  ensureLocalWs() {
    if (!this.localWs || this.localWs.readyState === WebSocket.CLOSED || this.localWs.readyState === WebSocket.CLOSING) {
      this.wsReconnectDelay = WS_RECONNECT_MIN_MS;
      this.connectLocalWs();
    }
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

  // Every packet travels over both Supabase and the local WS: drop the second copy
  // (and any stale out-of-order packet) by its sender timestamp
  isDuplicate(payload, key) {
    const ts = payload && payload.timestamp;
    if (!ts) return false;
    // A much older timestamp means a new sender with a skewed clock: accept and resync
    if (this[key] && ts <= this[key] && this[key] - ts < 30000) return true;
    this[key] = ts;
    return false;
  }

  handleGpsPacket(payload) {
    this.lastPacketTime = Date.now();
    this.setConnected(true);
    if (this.isDuplicate(payload, 'lastGpsTimestamp')) return;
    this.onGpsUpdate(payload);
  }

  handleDestinationPacket(payload) {
    this.lastPacketTime = Date.now();
    this.setConnected(true);
    if (this.isDuplicate(payload, 'lastDestinationTimestamp')) return;
    this.onDestinationSet(payload);
  }

  handlePing(payload) {
    // Only accept ping from the counterpart device
    if (payload && payload.role && payload.role !== this.role) {
      this.lastPacketTime = Date.now();
      this.setConnected(true);
    }
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
      if (this.role === 'display') {
        if (this.lastPacketTime > 0) {
          const elapsed = Date.now() - this.lastPacketTime;
          if (elapsed > 8000) {
            this.setConnected(false);
          }
        } else {
          this.setConnected(false);
        }
      }
      this.sendPing();
    }, 4000);
  }
}
