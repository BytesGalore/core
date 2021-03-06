/** @fileOverview Mid-level connection broking and signaling functionality. */

/**
 * @constructor
 * @class Handles the connection establishment to other nodes as
 * well as joining a network (bootstrapping).
 */
ConnectionManager = function() {
    if(!(this instanceof ConnectionManager)) {
        return new ConnectionManager();
    }
    this._bootstrap = null;
    this._pending = {};
    this._connections = {};
    this._pcoptions = {
        //iceServers: [{url: 'stun:127.0.0.1'}]
    };
    //possible states: 'uninitialized', 'bootstrapping', 'ready'
    this._state = 'uninitialized';

    return this;
};

ConnectionManager.prototype = {

    utils: {
        /**
         * Returns a list of field values of the given field in the given SDP.
         */
        findInSDP: function(sdp, field) {
            var result = [];
            sdp.split('\r\n').forEach(function(line) {
                if(line.match(new RegExp("^" + field + "="))) {
                    result.push(line.split("=", 2)[1]);
                }
            });
            return result;
        },

        /**
         * Returns the session ID contained in the given SDP. This ID is used
         * for glare handling.
         */
        findSessionId: function(sdp) {
            return parseInt(this.findInSDP(sdp, "o")[0].split(" ")[1], 10);
        },
    },

    /**
     * Connects this instance to the P2P network by establishing a DataChannel
     * connection to an arbitrary peer.
     *
     * @param router {Router} used for delivering the initial offer.
     * @param successCallback {Function} called when a connection has been established
     * and the peer is ready to send/receive data.
     * @param errorCallback {Function} called when the connection could not be
     * established.
     */
    bootstrap: function(router, successCallback, errorCallback) {
        if(this._state !== 'uninitialized') {
            errorCallback('Invalid state');
            return;
        }
        this._state = 'bootstrapping';
        this._router = router;
        var pc = new RTCPeerConnection(this._pcoptions);
        this._bootstrap = {
            pc: pc,
            dc: pc.createDataChannel(null, {}),
            onsuccess: successCallback,
            onerror: errorCallback,
        };
        router.registerDeliveryCallback('offer', this._onReceiveOffer.bind(this));
        router.registerDeliveryCallback('answer', this._onReceiveAnswer.bind(this));
        router.registerDeliveryCallback('denied', this._onOfferDenied.bind(this));
        pc.createOffer(this._onCreateOfferSuccess.bind(this, pc, null, this._bootstrap),
                       this._onCreateOfferError.bind(this, errorCallback));
    },

    /**
     * Creates a DataChannel connection to the given peer.
     *
     * @param to ID of the remote peer
     * @param successCallback {Function} called when the connection has been
     * established
     * @param errorCallback {Function} called when the connection establishment
     * failed
     */
    connect: function(to, successCallback, errorCallback) {
        if(this._state !== 'ready') {
            errorCallback('Invalid state');
            return;
        }
        if(this._pending[to] !== undefined) {
            errorCallback('Already connecting');
        }
        var pc = new RTCPeerConnection(this._pcoptions);
        var dc = pc.createDataChannel(null, {});
        this._pending[to] = {
            pc: pc,
            dc: dc,
            onsuccess: successCallback,
            onerror: errorCallback,
        };
        pc.createOffer(this._onCreateOfferSuccess.bind(this, pc, to, this._pending[to]),
                       this._onCreateOfferError.bind(this, errorCallback));
    },

    _onCreateOfferSuccess: function(pc, to, pendingOffer, sessionDesc) {
        if(pendingOffer.drop) {
            return;
        }
        pc.setLocalDescription(sessionDesc);
        pendingOffer.offerId = this.utils.findSessionId(sessionDesc.sdp);
        this._router.route(to, 'offer', {offer: sessionDesc});
    },

    _onCreateOfferError: function(errorCallback, error) {
        // TODO(max): clean up state (delete PC object etc.)
        errorCallback(error);
    },

    _onReceiveAnswer: function(msg, from) {
        if(this._state === 'bootstrapping') {
            // TODO(max): check if we actually have a pending PC
            this._bootstrap.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
            this._bootstrap.dc.onopen = function(ev) {
                this._router.addPeer(new Peer(from, this._bootstrap.pc, this._bootstrap.dc));
                this._state = 'ready';
                this._bootstrap.onsuccess();
                this._bootstrap = null;
            }.bind(this);
        } else {
            var pending = this._pending[from];
            if(pending === undefined) {
                return; // we haven't offered to this node, silently discard
            }
            pending.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
            pending.dc.onopen = function(ev) {
                var peer = new Peer(from, pending.pc, ev.target);
                this._router.addPeer(peer);
                if(typeof(pending.onsuccess) === 'function') {
                    // TODO(max): would it make sense to pass the remote peer's
                    // ID to the handler?
                    pending.onsuccess();
                }
                delete this._pending[from];
                this._connections[from] = peer;
            }.bind(this);
        }
    },

    _onReceiveOffer: function(msg, from) {
        // if we're already connected or are already processing an offer from
        // this peer, deny this offer
        if(this._connections[from] !== undefined || this._pending[from] !== undefined) {
            this._router.route(from, 'denied', '');
        }

        var offerId = this.utils.findSessionId(msg.offer.sdp);

        if(this._state === 'bootstrapping') {
            if(this._bootstrap.pc.remoteDescription !== null) {
                // we already have a bootstrap peer
                return;
            }
            if(offerId > this._bootstrap.offerId) {
                // discard our offer and accept this one
                var newBootstrap = {
                    pc: new RTCPeerConnection(this._pcoptions),
                    onsuccess: this._bootstrap.onsuccess,
                    onerror: this._bootstrap.onerror,
                };
                // cancel all actions on the old object
                this._bootstrap.drop = true;
                this._bootstrap = newBootstrap;
            } else {
                // silently discard this offer
                return;
            }
            this._bootstrap.pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            this._bootstrap.pc.ondatachannel = function(ev) {
                ev.channel.onopen = function(ev) {
                    var peer = new Peer(from, this._bootstrap.pc, ev.target);
                    this._router.addPeer(peer);
                    this._state = 'ready';
                    this._bootstrap.onsuccess();
                    this._connections[from] = peer;
                    this._bootstrap = null;
                }.bind(this);
            }.bind(this);
            this._bootstrap.pc.createAnswer(this._onCreateAnswerSuccess.bind(this, from, this._bootstrap.pc), this._onCreateAnswerError.bind(this));
        } else {
            var pendingOffer = this._pending[from];
            if(pendingOffer !== undefined) {
                // handle glare
                if(offerId > pendingOffer.offerId) {
                    // discard our offer and accept this one
                    newPendingOffer = {
                        onsuccess: pendingOffer.onsuccess,
                        onerror: pendingOffer.onerror,
                    };
                    pendingOffer = newPendingOffer;
                    delete this._pending[from];
                } else {
                    // silently discard this offer
                    return;
                }
            }
            var pc = new RTCPeerConnection(this._pcoptions);
            pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            this._pending[from] = pendingOffer || {};
            this._pending[from].pc = pc;
            pc.ondatachannel = function(ev) {
                ev.channel.onopen = function(ev) {
                    var peer = new Peer(from, pc, ev.target);
                    this._router.addPeer(peer);
                    if(typeof(this._pending[from].onsuccess) === 'function') {
                        this._pending[from].onsuccess();
                    }
                    delete this._pending[from];
                    this._connections[from] = peer;
                }.bind(this);
            }.bind(this);
            pc.createAnswer(this._onCreateAnswerSuccess.bind(this, from, pc), this._onCreateAnswerError.bind(this));
        }
    },

    _onCreateAnswerSuccess: function(to, pc, sessionDesc) {
        pc.setLocalDescription(new RTCSessionDescription(sessionDesc));
        this._router.route(to, 'answer', {answer: sessionDesc});
    },

    _onCreateAnswerError: function(error) {
        console.log(error);
    },

    /**
     * The server denies offers when only one peer is connected since there is
     * no other peer that could answer the offer. In that case the first peer
     * just has to sit and wait for an offer. Eventually the successCallback is
     * called.
     */
    _onOfferDenied: function(msg) {
        if(this._state === 'bootstrapping') {
            this._bootstrap.pc = new RTCPeerConnection(this._pcoptions);
            this._bootstrap.dc = this._bootstrap.pc.createDataChannel(null, {});
            this._bootstrap.offerId = null;
        }
    },

};

if(typeof(module) !== 'undefined') {
    module.exports = ConnectionManager;
}
