import { createParser, PKT_TRACKER_TIMESTAMP } from 'shocked-common';
import TrackerClient from './TrackerClient';

// Try reconnection in few second(s)
const RECONNECT_INTERVAL = 2500;

const EventEmitter = require('events');

function getHost(endpoint) {
  // convert http to ws
  if (endpoint.startsWith('https:') || endpoint.startsWith('http:')) {
    return 'ws'.concat(endpoint.substr(4));
  }

  // use ws as is
  if (endpoint.startsWith('wss:') || endpoint.startsWith('ws:')) {
    return endpoint;
  }

  // fallback if the endpoint is not recognizable
  throw new Error(`Invalid endpoint ${endpoint}. It should start with one of http:, https:, ws: or wss:`);
}

function createClient(endpoint, WebSocket = global.WebSocket) {
  const host = getHost(endpoint);

  // Using an array, since the number of trackers is not expected
  // to be very high, typically 2 trackers at a time
  const trackers = [];
  function findTracker(trackerId) {
    return trackers.find(tracker => tracker.group === trackerId);
  }

  const parser = createParser();

  const eventManager = new EventEmitter();

  // There is a bug. Even when the connection is successful, the timer closes the connection
  // and proceeds to make another connection, which is again closed by the timer and this
  // goes on and on.
  // The issue seems to be this:
  //    1. During a reconnection or connection event
  //       i. The previous connection is shutdown
  //      ii. A new connection is established
  //     iii. In certain cases, the old socket close event arrives later than the
  //          the new connection open event

  let reconnectTimerHandle = null;
  function setupReconnection(interval) {
    if (reconnectTimerHandle) {
      return;
    }

    reconnectTimerHandle = setTimeout(() => {
      reconnectTimerHandle = null;
      // eslint-disable-next-line no-use-before-define
      client.reconnect();
    }, interval);
  }

  function clearRetry() {
    if (reconnectTimerHandle) {
      clearTimeout(reconnectTimerHandle);
      reconnectTimerHandle = null;
    }
  }

  function connection(remoteUrl) {
    if (remoteUrl === null) {
      return null;
    }

    const sock = new WebSocket(remoteUrl);
    sock.onerror = (e) => {
      // the onclose event would be hit after the onerror, so just warn about the error for
      // development mode
      // eslint-disable-next-line no-console
      console.warn(e.message);
    };

    sock.onopen = () => {
      // Clear any auto reconnect attempts
      clearRetry();

      // Let all the trackers know tha we are now connected
      trackers.forEach((tracker) => {
        // eslint-disable-next-line no-use-before-define
        tracker.onConnect(client);
      });

      // Trigger the connect event
      eventManager.emit('connect');
    };

    sock.onclose = (e) => {
      // do not try to reconnect for specific errors
      // 1000: regular socket shutdown
      // 1001: TODO: This seems to be the code when the client initiates close.
      //             Should the retry be avoided in this case as well
      // 1005: Expected close status, recevied none - ???
      // 4001: Session expired - via shocked
      if (e.code !== 1000 && e.code !== 1005 && e.code !== 4001) {
        // eslint-disable-next-line no-use-before-define
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
          // Try to reconnect again after sometime
          setupReconnection(RECONNECT_INTERVAL);
        }
      }

      // In some cases, the close event of the previous socket might arrive later than the
      // open event of the new connection, avoid making a connection here
      // eslint-disable-next-line no-use-before-define
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        trackers.forEach((tracker) => {
          // Let all the trackers know that the client is not available
          tracker.onDisconnect();
        });

        // Fire the close event on client
        eventManager.emit('disconnect', e.code);
      }
    };


    sock.onmessage = (e) => {
      parser.parse(e.data);
    };

    return sock;
  }

  parser.onTrackerOpen = (trackerId) => {
    const tracker = findTracker(trackerId);
    if (tracker) {
      tracker.onOpen(trackerId);
    }
  };

  parser.onTrackerClose = (trackerId, code, message) => {
    const tracker = findTracker(trackerId);
    if (tracker) {
      tracker.onClose(code, message);
    }
  };

  parser.onTrackerAction = (trackerId, action, serial) => {
    const tracker = findTracker(trackerId);
    if (tracker) {
      tracker.onAction(action, serial);
    }
  };

  parser.onTrackerApiResponse = (trackerId, apiId, status, response, params) => {
    const tracker = findTracker(trackerId);
    if (tracker) {
      tracker.onApiResponse(apiId, status, response, params);
    }
  };

  parser.onTrackerEmit = (trackerId, event, data) => {
    const tracker = findTracker(trackerId);
    if (tracker) {
      tracker.emit(event, data);
    }
  };

  parser.onTrackerTimestamp = trackerId => (
    // eslint-disable-next-line no-use-before-define
    client.send(PKT_TRACKER_TIMESTAMP(trackerId, Date.now()))
  );

  // Initialize with a connection attempt
  let socket = null;
  let url = null;

  const client = {
    on: (event, listener) => {
      if (listener) {
        eventManager.on(event, listener);
      }
    },

    off: (event, listener) => {
      if (listener) {
        eventManager.removeListener(event, listener);
      }
    },

    isConnected: () => socket && socket.readyState === WebSocket.OPEN,

    connect: (path) => {
      url = `${host}/${path}`;
      if (client.isConnected() && socket.url === url) {
        return true;
      }

      if (socket !== null) {
        socket.close();
      }

      socket = connection(url);
      return true;
    },

    clearPath: () => {
      url = null;
      if (socket !== null) {
        socket.close();
        socket = null;
      }
    },

    reconnect: () => {
      // Only make a reconnect event if the socket is already connected
      if (url === null || (socket && socket.readyState === WebSocket.CONNECTING)) {
        // No prior url to reconnect to
        return false;
      }

      // Since its a reconnect attempt, we will close existing socket
      if (socket !== null) {
        socket.close();
      }

      socket = connection(url);
      return true;
    },

    close: () => {
      if (socket) {
        socket.close();
      }
      socket = null;

      clearRetry();
    },

    send: (data) => {
      if (!client.isConnected()) {
        return;
      }

      socket.send(data);
    },

    createTracker: (trackerId, store, params = {}) => {
      // make sure this trackerId is unique for this client
      if (trackers.find(tracker => tracker.trackerId === trackerId)) {
        throw new Error(`A tracker for ${trackerId} already exists on the client. There can only be one tracker for one trackerId.`);
      }

      const tracker = new TrackerClient(store, trackerId, params, () => {
        const idx = trackers.indexOf(tracker);
        if (idx >= 0) {
          trackers.splice(idx, 1);
        }
      });

      // Include the tracker in the list
      trackers.push(tracker);
      return tracker;
    },
  };

  return client;
}

export default createClient;
