
'use strict';

var WebSocket = require('ws');
var EventEmitter2 = require('eventemitter2').EventEmitter2;
var util = require('util');
var log = require('debug')('interactor:ws');

/**
 * Websocket Transport used to communicate with KM
 * @param {Object} opts options
 * @param {Daemon} daemon Interactor instance
 */
function WebsocketTransport (opts, daemon) {
  this.opts = opts;
  this._daemon = daemon;
  this._ws = null;

  // instanciate the eventemitter
  this._bus = new EventEmitter2({
    wildcard: true,
    delimiter: ':'
  });

  // inherit EE properties
  util.inherits(this, this._bus);
}

/**
 * Connect the websocket client to a url
 * @param {String} url where the client will connect
 * @param {Function} cb invoked with <err>
 */
WebsocketTransport.prototype.connect = function (url, cb) {
  this._host = url;
  this._ws = new WebSocket(url);
  this._ws.once('error', cb);
  this._ws.once('open', cb);

  this._ws.on('close', this._onClose.bind(this));
  this._ws.on('error', this._onError.bind(this));
  this._ws.on('message', this._onMessage.bind(this));
};

/**
 * Disconnect the websocket client
 */
WebsocketTransport.prototype.disconnect = function () {
  if (this.isConnected()) {
    this._ws.close(0, 'Disconnecting');
  }
};

/**
 * Disconnect and connect to a url
 * @param {String} url where the client will connect [optionnal]
 * @param {Function} cb invoked with <err>
 */
WebsocketTransport.prototype.reconnect = function (url, cb) {
  if (typeof url === 'function') {
    cb = url;
    url = this._host;
  }

  this.disconnect();
  this.connect(url, cb);
};

/**
 * Is the websocket connection ready
 * @return {Boolean}
 */
WebsocketTransport.prototype.isConnected = function () {
  return this._ws.readyState === 1;
};

// PRIVATE METHODS //

/**
 * Broadcast the close event from websocket connection
 * @private
 * @param {Integer} code
 * @param {String} reason
 */
WebsocketTransport.prototype._onClose = function (code, reason) {
  this.emit('close', code, reason);
};

/**
 * Broadcast the error event from websocket connection
 * and eventually close the connection if it isnt already
 * @private
 * @param {Error} err
 */
WebsocketTransport.prototype._onError = function (err) {
  // close connection if needed
  if (this.isConnected()) {
    this._ws.close(400, err.message);
  }
  this.emit('error', err);
};

/**
 * Broadcast the close event from websocket connection
 * @private
 * @param {Integer} code
 * @param {String} reason
 */
WebsocketTransport.prototype._onMessage = function (data, flags) {
  // ensure that all required field are present
  if (!data || !data.version || !data.payload || !data.channel) {
    return log('Received message without all necessary fields');
  }
  this.emit(data.channel, data.payload);
};
