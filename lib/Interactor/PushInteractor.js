
'use strict';

var debug = require('debug')('interactor:push-interactor');
var fs = require('fs');
var path = require('path');
var cst = require('../../constants.js');
var Filter = require('./Filter.js');
var Utility = require('./Utility.js');
var Aggregator = require('./TransactionAggregator.js');

var PushInteractor = module.exports = function (opts, ipm2, transport) {
  this._ipm2 = ipm2;
  this.transport = transport;
  this.opts = opts;
  this.logs_buffer = {};
  this.broadcast_logs = false;

  this._cacheFS = new Utility.Cache({
    miss: function (key) {
      try {
        var content = fs.readFileSync(path.resolve(key));
        return content.toString().split(/\r?\n/);
      } catch (err) {
        return debug('Error while trying to get file from FS : %s', err.message || err);
      }
    }
  });
  this._stackParser = new Utility.StackTraceParser({ cache: this._cacheFS, context: cst.CONTEXT_ON_ERROR });
  this.aggregator = new Aggregator(this);
};

PushInteractor.prototype.start = function () {
  // stop old running task or event listener
  if (this._pm2_listener !== undefined || this._worker_executor !== undefined) {
    this.stop();
  }
  this._worker_executor = setInterval(this._worker.bind(this), cst);
  this._pm2_listener = this._onPM2Event;
  this._ipm2.bus.on('*', this._pm2_listener.bind(this));
};

PushInteractor.prototype.stop = function () {
  if (this._pm2_listener !== undefined) {
    this._ipm2.bus.removeListener('*', this._pm2_listener);
    this._pm2_listener = null;
  }
  if (this._worker_executor !== undefined) {
    clearInterval(this._worker_executor);
    this._worker_executor = null;
  }
};

PushInteractor.prototype._onPM2Event = function (event, packet) {
  if (event === 'axm:action') return false;

  // bufferize logs
  if (event.match(/^log:/)) {
    if (!this.log_buffer[packet.process.pm_id]) {
      this.log_buffer[packet.process.pm_id] = [];
    }
    // push the log data
    this.log_buffer[packet.process.pm_id].push(packet.data);
    // delete the last one if too long
    if (this.log_buffer[packet.process.pm_id].length >= cst.LOGS_BUFFER) {
      this.log_buffer[packet.process.pm_id].pop();
    }

    // don't send logs if not enabled
    if (!this.broadcast_logs) return false;
  }

  // attach additional info for exception
  if (event === 'process:exception') {
    packet.data.last_logs = this.log_buffer[packet.process.pm_id];

    // try to parse stacktrace and attach callsite + context if available
    if (typeof packet.data.stackframes === 'object') {
      var result = this.stackParser.parse(packet.data.stackframes);
      // no need to send it since there is already the stacktrace
      delete packet.data.stackframes;
      if (result) {
        packet.data.callsite = result.callsite || undefined;
        packet.data.context = result.context || undefined;
      }
    }
  }

  if (event === 'axm:reply' && packet.data && packet.data.return && (packet.data.return.heapdump || packet.data.return.cpuprofile)) {
    this._sendFile(packet);
    return false;
  }

  if (event === 'human:event') {
    packet.name = packet.data.__name;
    delete packet.data.__name;
  }

  if (!packet.process) return console.error('No process field [%s]', event);

  // Normalize data
  packet.process = {
    pm_id: packet.process.pm_id,
    name: packet.process.name,
    rev: packet.process.rev || ((packet.process.versioning && packet.process.versioning.revision) ? packet.process.versioning.revision : null),
    server: PushInteractor.conf.MACHINE_NAME
  };

  // agregate transaction data before sending them
  if (event.indexOf('axm:trace') > -1) return this.aggregator.aggregate(packet);

  if (event.match(/^log:/)) {
    packet.log_type = event.split(':')[1];
    event = 'logs';
  }

  return this.transport.send(event, packet);
};

PushInteractor.prototype._worker = function () {
  var self = this;
  this._ipm2.rpc.getMonitorData({}, function (err, processes) {
    if (err || !processes) {
      return console.error(err || 'Cant access to getMonitorData RPC PM2 method');
    }

    var monitoring = Filter.monitoring(processes, self.opts);
    if (monitoring) {
      self.transport.send('monitoring', monitoring);
    }

    var status = Filter.status(processes, self.opts);
    if (status) {
      self.transport.send('status', {
        data: status,
        server_name: self.opts.MACHINE_NAME,
        internal_ip: self.opts.internal_ip,
        protected: global._pm2_password_protected
      });
    }
  });
};

/**
 * Handle reporting of heapdump/cpu profiling file
 */
PushInteractor.prototype._sendFile = function (packet) {
  var self = this;
  var file = JSON.parse(JSON.stringify(packet.data.return.dump_file));
  var type = packet.data.return.heapdump ? 'heapdump' : 'cpuprofile';

  packet = {
    pm_id: packet.process.pm_id,
    name: packet.process.name,
    server_name: PushInteractor.conf.MACHINE_NAME,
    public_key: self.conf.PUBLIC_KEY,
    type: type
  };

  fs.readFile(file, function (err, data) {
    if (err) return console.error(err);
    fs.unlink(file, console.error);
    packet.data = data;
    return self.transport.send(type, packet);
  });
};
