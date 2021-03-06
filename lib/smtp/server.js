/*
  File: server.js

  Author: Kenneth Kalmer, Philip Hofstetter

  Description:
    This file implements an SMTP server as defined in RFC2821.

  Implements:
    ESMTP: RFC2821

  Issues:
    Plenty, have patience.

*/

// Global
var net = require('net');
var sys = require('sys');
var Promise = require('../vendor/Promise');

// Local
var enable_debug = false;
var eol = "\r\n";

/*
  RFC2821 defines an SMTP Session
*/
var SMTPSession = function(server) {

  this.SMTPServer = server;
  this.heloHost = null;
  this.fromAddress = null;
  this.recipients = [];
  this.callbacks = [];
  this.socket = null;
  this.buffer = "";
  this.data = null;
  this.in_data = false;
  this.esmtp = false;
};

sys.inherits( SMTPSession, process.EventEmitter );

SMTPSession.prototype.connect = function( socket ) {

  var session = this;
  this.socket = socket;

  // callbacks first
  socket.addListener( 'data', function(packet) {
    session.receive( packet )
  });
  socket.addListener( 'end', function() {
    // close on our end. If we don't, remotely closed connections will stay half
    // open forever (in CLOSE_WAIT) or until we die of handle starvation or OOM
    socket.end();
    if ( this.listeners('end').length >= 0 ) {
      session.emit( 'end', session );
    }
    delete(session);
  });
  socket.addListener( 'error', function(){
    sys.debug("got socket error in server library");
    socket.end();
  });

// following two callbacks are not used at this time
//  socket.addListener( 'eol', session.eol );
//  socket.addListener( 'close', session.close );

  if (enable_debug)
    sys.puts('Connect listeners: ' + sys.inspect( this.listeners('connect') ) );
  if ( this.listeners('connect').length <= 0 ) {
    session.greeting();

  } else {
    var promise = new Promise.Promise();
    promise.addCallback( function() {
      session.greeting();
    });
    promise.addErrback( function( args ) {
      var message = args[0], quit = args[1];

      session.error( message );
      if( quit ) session.quit();
    });

    this.emit( 'connect', socket.remoteAddress, promise, this );
  }

};

// patterns for commands
SMTPSession.prototype.command_patterns = {
  helo: /^HELO\s*/i,
  ehlo: /^EHLO\s*/i,
  quit: /^QUIT/i,
  from: /^MAIL FROM:\s*/i,
  rcpt: /^RCPT TO:\s*/i,
  data: /^DATA/i,
  noop: /^NOOP/i,
  rset: /^RSET/i,
  vrfy: /^VRFY\s+/i,
  expn: /^EXPN\s+/,
  help: /^HELP/i,
  tls: /^STARTTLS/i,
  auth: /^AUTH\s+/i
};

// Events emitted
SMTPSession.prototype.events = [
  'connect',
  'end',
  'ehlo',
  'helo',
  'mail_from',
  'rcpt_to',
  'data',
  'data_available',
  'data_end'
];

// Replies

SMTPSession.prototype.send = function( s ) {
  if( this.socket.readyState == 'open' ) {
    if (enable_debug)
      sys.print("SENDING: " + s + eol);
    this.socket.write( s + eol );
  }
};

SMTPSession.prototype.greeting = function() {
  this.send("220 " + this.SMTPServer.hostname + " ESMTP node.js");
};

SMTPSession.prototype.notSupported = function(){
  this.send( "500 not supported" );
};

SMTPSession.prototype.sendOk = function() {
  this.send( "250 OK" );
};

SMTPSession.prototype.error = function( message, status ) {
  var code = status || 500;

  this.send( code + " " + message );
};

// Commands
SMTPSession.prototype.ehlo = function() {
  var session = this;
  var hostname = this.heloHost = this.extractArguments( 'EHLO' );
  this.esmtp = true;

  if (enable_debug)
    sys.puts('EHLO listeners: ' + sys.inspect( this.listeners('ehlo') ) );

  if ( this.listeners('ehlo').length <= 0 ) {
    session.send('250-' + this.SMTPServer.hostname + ' Hello ' + this.socket.remoteAddress );
    session.send('250 8BITMIME');

  } else {
    var promise = new Promise.Promise();
    promise.addCallback( function(addcaps) {
      var i = 0;
      session.send('250-' + session.SMTPServer.hostname + ' Hello ' + session.socket.remoteAddress );
      if (addcaps){
        for(i = 0; i < addcaps.length; i++){
          session.send('250-'+addcaps[i]);
        }
      }
      session.send('250 8BITMIME');
    });
    promise.addErrback( function( message, quit ) {
      session.error( message );
      if( quit ) session.quit();
    });

    this.emit( 'ehlo', hostname, promise, this );
  }
};

SMTPSession.prototype.helo = function() {
  var session = this;
  var hostname = this.heloHost = this.extractArguments( 'HELO' );

  if (enable_debug)
    sys.puts('HELO listeners: ' + sys.inspect( this.listeners('ehlo') ) );

  if ( this.listeners('helo').length <= 0 ) {
    session.send('250 ' + this.SMTPServer.hostname + ' Hello ' + this.socket.remoteAddress );

  } else {
    var promise = new Promise.Promise();
    promise.addCallback( function() {
      session.send('250 ' + session.SMTPServer.hostname + ' Hello ' + session.socket.remoteAddress );
    });
    promise.addErrback( function( message, quit ) {
      session.error( message );
      if( quit ) session.quit();
    });

    this.emit( 'helo', hostname, promise, this );
  }
};

SMTPSession.prototype.receiver = function() {
  var session = this;

  if (this.fromAddress == null){
    this.send("503 provide sender first");
    return;
  }

  var addr = this.extractArguments( 'RCPT TO:' ).replace(/[<>]/g, '');

  if (addr.match(/^[^@]+@[^@.][^@]+\.[^@.]+$/)){
    if ( this.listeners('rcpt_to').length <= 0 ) {
      this.recipients[session.recipients.length] = addr;
      this.sendOk();
    } else {
      var promise = new Promise.Promise();
      promise.addCallback( function(new_to) {
        session.recipients[session.recipients.length] = new_to || addr;
        session.sendOk();
      });
      promise.addErrback( function( args ) {
        // quit is 1 everywhere, so keep that for consistencies sake
        var message = args[0], quit = args[1], status = args[2];
        status = status || 500;

        session.error( message, status );
        if( quit ) session.quit();
      });
      this.emit( 'rcpt_to', addr, promise, this );
    }
  }else{
    this.error("keep address simpler. Please. We only support user@host.domain", 501);
  }
};

SMTPSession.prototype.sender = function() {
  var session = this;

  if (this.heloHost == null){
      this.send("503 we require greeting");
      return;
  }
  var addr = this.extractArguments( 'MAIL FROM:' ).replace(/[<>]/g, '');

  if ( this.listeners('mail_from').length <= 0 ) {
    if (addr.match(/^[^@]+@[^@.][^@]+\.[^@.]+$/)){
      session.fromAddress = addr;
      this.sendOk();
    }else{
      this.error("keep address simpler. Please. We only support user@host.domain", 501);
    }
  } else {
    var promise = new Promise.Promise();
    promise.addCallback( function(new_from) {
      session.fromAddress = new_from || addr;
      session.sendOk();
    });
    promise.addErrback( function( args ) {
      // quit is 1 everywhere, so keep that for consistencies sake
      var message = args[0], quit = args[1], status = args[2];
      status = status || 500;

      session.error( message, status );
      if( quit ) session.quit();
    });
    this.emit( 'mail_from', addr, promise, this, this.extractArguments('MAIL FROM:') );
  }
};

SMTPSession.prototype.startData = function() {
  var session = this;

  var cont = function(){
    session.in_data = true;
    session.last_data_packet = undefined;

    session.send("354 Terminate with line containing only '.'");
  };

  if (this.recipients.length == 0){
    this.error("need recipient", 503);
    return;
  }

  if ( this.listeners('data').length <= 0 ) {
    cont();
  } else {
    var promise = new Promise.Promise();
    promise.addCallback( function() {
      cont();
    });
    promise.addErrback( function( args ) {
      // quit is 1 everywhere, so keep that for consistencies sake
      var message = args[0], quit = args[1], status = args[2];
      status = status || 500;

      session.error( message, status );
      if( quit ) session.quit();
    });

    // keeping the interface intact even though we don't have anything
    // protocol related to pass
    this.emit( 'data', undefined, promise, this );
  }
};

SMTPSession.prototype.quit = function() {
  this.send( '221 ' + this.SMTPServer.hostname + ' closing connection' );
  this.socket.end();
};

// Handlers
SMTPSession.prototype.receive = function( packet ) {
  if (enable_debug)
    sys.puts('Received data: ' + packet);

  // if our client is using the streaming interface, we don't accumulate the
  // data in our buffer, otherwise, the whole point is defeated :-)

  if (!this.in_data || this.listeners('data_available').length == 0){
    this.buffer += packet;
  }


  if ( this.in_data ) {
    this.dataReceived(packet);
    this.last_data_packet = packet;

  } else if ( this.buffer.indexOf( eol ) != 1 ) {
    var command = null;

    for( var cmd in this.command_patterns ) {
      if (this.command_patterns[ cmd ].test( this.buffer ) ) {

          command = cmd;
          break;
      }
    }

    if (enable_debug)
      sys.puts( 'Command: ' + sys.inspect(command) );

    switch( cmd ) {
      case 'ehlo':
        this.ehlo();
        break;
      case 'helo':
        this.helo();
        break;
      case 'rcpt':
        this.receiver();
        break;
      case 'from':
        this.sender();
        break;
      case 'data':
        this.startData();
        break;
      case 'quit':
        this.quit();
        break;
      default:
        this.notSupported();
    }

    this.buffer = "";
  }
};

SMTPSession.prototype.dataReceived = function(packet){
  var session = this;
  var re = new RegExp( eol + "\\." + eol );

  // assembling last seen packet with current packet to check for
  // crlf.crlf
  var check = this.last_data_packet ? this.last_data_packet + packet : packet;

  if( re.test( check ) ) {
    if ( this.listeners('data_end').length <= 0 ) {
      this.data = this.buffer.substr( 0, this.buffer.length - 5 ); // \r\n.\r\n
      this.buffer = "";
      this.in_data = false;
      this.sendOk();
    }else{

      triggerEnd = function(data){
        var p = new Promise.Promise();

        p.addCallback( function() {
          session.in_data = false;
          session.buffer = "";
          session.sendOk();
        });

        p.addErrback( function( args ) {
          var message = args[0], quit = args[1], status = args[2];
          status = status || 500;

          session.error( message, status );
          if( quit ) session.quit();
        });

        session.emit( 'data_end', data, p, session );
      };

      if (this.listeners('data_available').length > 0){
        var s = "" + packet;
        var pd = new Promise.Promise();
        pd.addCallback(function(){
          triggerEnd(s.substr(s.length - 5));
        });
        session.emit('data_available', s.substr(0, s.length - 5), pd, this);
      }else{
        triggerEnd(this.buffer.substr(0, this.buffer.length - 5))
      }
    }
  }else{
    if ( this.listeners('data_available').length > 0 ) {
      var promise = new Promise.Promise();
      promise.addErrback( function( args ) {
        var message = args[0], quit = args[1], status = args[2];
        status = status || 500;
        session.error( message, status );
        if( quit ) session.quit();
      });

      this.emit( 'data_available', packet, promise, this );
    }
  }
};

// Utilities

SMTPSession.prototype.extractArguments = function( command ) {
  var re = new RegExp("^"+command, "i");
  return this.buffer.replace( re, '' ).replace(/^\s\s*/, '').replace(/\s\s*$/, '');
};

/*
  Server class
*/
var Server = exports.Server = function() {
  process.EventEmitter.call( this );

  this.host = 'localhost';
  this.port = 10025;
  this.callbacks = [];
  this.server = null;
  this.hostname = '<hostname>';

  return this;
};

sys.inherits( Server, process.EventEmitter );

Server.prototype.runServer = function() {
  var self = this;
  this.server = net.createServer( function( socket ){

    var session = new SMTPSession(self);

    // Only add listeners to the session if folks are listening to us.
    session.events.forEach( function( e ) {
      if( self.listeners( e ).length > 0 ) {
        var ev = e;
        session.addListener( e, function() {
          self.emit( ev, arguments );
        });
      }
    });

    session.connect( socket );

    return session;
  });

  this.server.listen( this.port, this.host );
};
