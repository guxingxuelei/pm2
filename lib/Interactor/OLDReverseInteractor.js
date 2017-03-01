/**
 * Copyright 2013 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

var debug    = require('debug')('interface:driver');
var nssocket = require('nssocket');
var Url      = require('url');
var Cipher   = require('./Cipher.js');
var util     = require('util');

var ReverseInteract = {
  changeUrl : function(url) {
    if (!this.connected) return;
    console.log('[REV] Changing URL to %s', url);

    this.network = Url.parse(url);
    this.socket.connect(parseInt(this.network.port), this.network.hostname);
    this.socket.reconnect();
  },
  destroy : function() {
    this.socket.destroy();
  },
  start : function(opts) {
    var self = this;

    if (!opts.url)
      throw new Error('url not declared');
    if (!opts.conf)
      throw new Error('Conf not passed to ReverseInteractor');

    this.connected    = false;
    this.conf         = opts.conf;
    this.network      = Url.parse(opts.url);
    this.pm2_instance = opts.conf.pm2_instance;

    this.socket = new nssocket.NsSocket({
      type          : 'tcp4',
      reconnect     : true,
      retryInterval : 100,
      max           : Infinity,
      maxListeners  : 50
    });

    this.socket.on('error', function(e) {
      self.connected = false;
      console.error('[REV] %s', e.message || e);
    });

    this.socket.on('close', function(dt) {
      self.connected = false;
    });

    this.socket.on('start', function() {
      self.connected = true;
      opts.conf.rev_con = true;
      console.log('[REV] Connected to %s:%s', self.network.hostname, self.network.port);
    });

    console.log('[REV] Connecting to %s:%s', this.network.hostname, this.network.port);

    this.socket.connect(parseInt(this.network.port), this.network.hostname);
    this.onMessage();
  },
  /**
   * Listening to remote events from Keymetrics
   */
  onMessage : function() {
    if (!this.socket) return console.error('Reverse interaction not initialized');

    /**
     * Identify this agent to Keymetrics
     * via PUBLIC/PRIVATE key exchange
     */
    ReverseInteract.introduceToKeymetrics();

    ReverseInteract.axmCustomActions();

    /**
     * From Pm2Actions.js
     */
    ReverseInteract.pm2Actions();

    ReverseInteract.pm2ScopedActions();

    return false;
  };
};

util._extend(ReverseInteract, require('./RemoteActions/Pm2Actions.js'));
util._extend(ReverseInteract, require('./RemoteActions/CustomActions.js'));

module.exports = ReverseInteract;
