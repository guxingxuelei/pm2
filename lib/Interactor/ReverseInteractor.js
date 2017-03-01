
'use strict';

var log = require('debug')('interactor:reverse-interactor');
var fs = require('fs');
var path = require('path');
var cst = require('../../constants.js');
var Utility = require('./Utility.js');

var PM2_REMOTE_METHOD_ALLOWED = {
  'restart': false,
  'reload': false,
  'gracefulReload': false,
  'reset': false,
  'scale': false,

  'install': true,
  'uninstall': true,
  'stop': true,
  'delete': true,
  'set': false,
  'multiset': false,
  'deepUpdate': true,

  'pullAndRestart': true,
  'forward': true,
  'backward': true,

  'startLogging': false,
  'stopLogging': false,

  // This is just for testing purproses
  'ping': true
};

var ReverseInteractor = module.exports = function (opts, pm2, transport) {
  this.pm2 = pm2;
  this.transport = transport;
  this.opts = opts;
};

ReverseInteractor.prototype.start = function () {
  this.transport.on('trigger:action', this._onCustomAction.bind(this));
  this.transport.on('trigger:scoped_action', this._onCustomAction.bind(this));
};

ReverseInteractor.prototype._onCustomAction = function (data) {
  var self = this;
  console.log('New remote action %s triggered for process %s', data.action_name, data.process_id);
  this.pm2.msgProcess({
    id: data.process_id,
    msg: data.action_name,
    opts: data.opts || null
  }, function (err, data) {
    if (err) {
      return self.transport.send('trigger:action:failure', {
        success: false,
        err: err.message,
        id: data.process_id,
        action_name: data.action_name
      });
    }
    console.log('[REVERSE] Message received from AXM for proc_id : %s and action name %s', data.process_id, data.action_name);

    return self.transport.send('trigger:action:success', {
      success: true,
      id: data.process_id,
      action_name: data.action_name
    });
  });
};

ReverseInteractor.prototype._onPM2Action = function (data) {
  var self = this;
  console.log('New remote action %s triggered for process %s', data.action_name, data.process_id);
  this.pm2.msgProcess({
    id: data.process_id,
    msg: data.action_name,
    action_name: data.action_name,
    opts: data.opts || null,
    uuid: data.uuid
  }, function (err, data) {
    if (err) {
      return self.transport.send('trigger:action:failure', {
        success: false,
        err: err.message,
        id: data.process_id,
        action_name: data.action_name
      });
    }
    console.log('[REVERSE] Message received from AXM for proc_id : %s and action name %s', data.process_id, data.action_name);

    return self.transport.send('trigger:action:success', {
      success: true,
      id: data.process_id,
      action_name: data.action_name
    });
  });
};
