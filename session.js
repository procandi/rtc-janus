/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var request = require('hyperquest');
var uuid = require('uuid');
var extend = require('cog/extend');
var jsonparse = require('cog/jsonparse');
var reTrailingSlash = /\/$/;

function JanusSession(opts) {
  if (! (this instanceof JanusSession)) {
    return new JanusSession(opts);
  }

  // initialise the id to null as this is generated by the server
  this.id = null;

  // set the uri to null
  this.uri = null;

  // initialise the plugins hash which will store plugin handle ids
  this.plugins = {};
}

util.inherits(JanusSession.prototype, EventEmitter);
module.exports = JanusSession;

var proto = JanusSession.prototype;

/**
  ### activate(namespace, callback)

**/
proto.activate = function(namespace, callback) {
  var parts = namespace.split('.');
  var session = this;
  var pluginName;

  // if we have not been provided, dot delimited plugin name then
  // prepend janus.plugin to the pluginName
  if (parts.length === 1) {
    namespace = 'janus.plugin.' + namespace;
    parts = namespace.split('.');
  }

  // get the plugin name (last part of the namespace)
  pluginName = parts[parts.length - 1];

  this._command('attach', { plugin: namespace }, function(err, data) {
    var id = data && data.id;

    if (err) {
      return callback(err);
    }

    // update the plugin handles to include this handle
    session.plugins[pluginName] = id;

    // patch in the plugin method
    session[pluginName] = proto._message.bind(session, id);

    // fire the callback
    callback();
  });
};

proto.connect = function(uri, callback) {
  var session = this;
  var transaction = uuid.v4();

  // update the url
  this.uri = uri.replace(reTrailingSlash, '');

  this._command('create', function(err, data) {
    if (err) {
      return callback(err);
    }

    session.id = data && data.id;
    callback();
  });
};

proto._command = function(command, payload, callback) {
  if (typeof payload == 'function') {
    callback = payload;
    payload = {};
  }

  return this._post(extend({}, payload, {
    janus: command
  }), callback);
};

proto._message = function(id, body, callback) {
  var payload;
  var session = this;

  if (typeof body == 'function') {
    callback = body;
    body = {};
  }

  // initialise the payload
  payload = {
    body: body,
    janus: 'message'
  };

  return this._post(payload, { path: id, ok: 'ack' }, function(err) {
    if (err) {
      return callback(err);
    }

    session._status(callback);
  });
};

proto._status = function(callback) {
  var req = request.get(this.uri + '/' + this.id + '?rid=' + Date.now());
  var chunks = [];

  console.log('requesting status');

  req.on('response', function(res) {
    var ok = res && res.statusCode === 200;

    console.log('got response: ', res);

    res.on('data', function(data) {
      chunks.push(data.toString());
    });

    res.on('end', function() {
      var body;

      if (! ok) {
        // TODO: more error details
        return callback(new Error('request failed: ' + res.statusCode));
      }

      // parse the response body
      body = jsonparse(chunks.join(''));
      console.log('received status response: ', body);

      // // check for success
      // if (body.janus !== okResponse) {
      //   return callback(new Error('request failed: ' + body.janus));
      // }

      // // check the transaction is a match
      // if (body.transaction !== payload.transaction) {
      //   return callback(new Error('request mismatch from janus'));
      // }

      // callback(null, body.data);;
    });
  });
};

proto._post = function(payload, opts, callback) {
  var req;
  var chunks = [];
  var uri = this.uri;
  var okResponse = 'success';

  if (typeof opts == 'function') {
    callback = opts;
    opts = {};
  }

  // if we have been provided a custom ok message, then use that instead
  if (opts.ok) {
    okResponse = opts.ok;
  }

  // if we have a valid session id then route the request to that session
  if (this.id) {
    uri += '/' + this.id + (opts && opts.path ? '/' + opts.path : '');
  }

  // create the request
  req = request.post(uri);

  // attach a transaction to the payload
  payload = extend({ transaction: uuid.v4() }, payload);

  req.setHeader('Content-Type', 'application/json');
  req.write(JSON.stringify(payload));

  req.on('response', function(res) {
    var ok = res && res.statusCode === 200;

    res.on('data', function(data) {
      chunks.push(data.toString());
    });

    res.on('end', function() {
      var body;

      if (! ok) {
        // TODO: more error details
        return callback(new Error('request failed: ' + res.statusCode));
      }

      // parse the response body
      body = jsonparse(chunks.join(''));

      // check for success
      if (body.janus !== okResponse) {
        return callback(new Error('request failed: ' + body.janus));
      }

      // check the transaction is a match
      if (body.transaction !== payload.transaction) {
        return callback(new Error('request mismatch from janus'));
      }

      callback(null, body.data);;
    });
  });

  req.end();
};