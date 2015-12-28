var Utils = require.main.require('./tools/utils');

var Player = require.main.require('./play/player');

var LIBERAL = 'liberal';
var FASCIST = 'fascist';
var NONE = 'none';

var FASCIST_POLICIES_REQUIRED = 6;
var LIBERAL_POLICIES_REQUIRED = 5;

var games = [];

var Game = function(size) {
	this.gid = Utils.uid();
	this.maxSize = size;
	this.players = [];
	this.state = {};
	this.turn = {};
	this.history = [];
	this.liberalEnacted = 0;
	this.fascistEnacted = 0;
	this.playerCount;
	this.currentCount;
	this.policyDeck;

	this.positionIndex = 0;
	this.specialPresident;
	this.presidentIndex = 0;
	this.electionTracker = 0;

	games.push(this);

//PRIVATE

	this.shufflePolicyDeck = function() {
		this.policyDeck = [];

		var cardsRemaining = 17 - this.fascistEnacted - this.liberalEnacted;
		var liberalsRemaining = 6 - this.liberalEnacted;
		for (var i = 0; i < cardsRemaining; ++i) {
			this.policyDeck[i] = i < liberalsRemaining ? LIBERAL : FASCIST;
		}
		this.policyDeck = Utils.randomize(this.policyDeck);
		console.log(this.policyDeck);
	}

//POLICIES

	this.peekPolicies = function() {
		return this.policyDeck.slice(0, 3);
	}

	this.getTopPolicies = function(count) {
		if (!count) {
			count = 3;
		}
		var policies = this.policyDeck.splice(0, count);
		if (this.policyDeck.length < 3) {
			this.shufflePolicyDeck();
		}
		return policies;
	}

	this.getTopPolicy = function() {
		return this.getTopPolicies(1)[0];
	}

//LOBBY

	this.emit = function(name, data) {
		io.to(this.gid).emit(name, data);
	}

	this.emitAction = function(name, data, secret) {
		data.action = name;
		if (secret) {
			console.log(secret);
			var target = Player.get(secret.target);
			target.emitOthers('game action', data);
			data.secret = secret;
			target.emit('game action', data);
		} else {
			this.emit('game action', data);
		}
		return data;
	}

	this.gameData = function() {
		var sendHistory = this.history;
		var sendPlayers = [];
		this.players.forEach(function(uid, index) {
			var player = Player.get(uid);
			sendPlayers[index] = {
				uid: uid,
				name: player.name,
				index: index,
			};
		});
		return {
			gid: this.gid,
			started: this.started,
			maxSize: this.maxSize,

			players: sendPlayers,
			history: sendHistory,
		}
	}

	this.start = function(socket) {
		this.started = true;
		this.playerCount = this.players.length;
		this.currentCount = this.playerCount;
		this.shufflePolicyDeck();

		this.emit('lobby game', this.gameData());
	}

	this.getFascistPower = function() {
		var enacted = this.fascistEnacted;
		if (enacted == 1) {
			// return 'investigate'; //SAMPLE
			return this.playerCount >= 9 ? 'investigate' : null;
		}
		if (enacted == 2) {
			return this.playerCount >= 7 ? 'investigate' : null;
		}
		if (enacted == 3) {
			return this.playerCount >= 7 ? 'election' : 'peek';
		}
		if (enacted == 4 || enacted == 5) {
			return 'bullet';
		}
	}

//STATE

	this.advanceTurn = function() {
		this.turn = {};
		if (this.specialPresident != null) {
			this.presidentIndex = this.specialPresident;
			this.specialPresident = null;
		} else {
			for (var attempts = 0; attempts < this.playerCount; ++attempts) {
				++this.positionIndex;
				if (this.positionIndex >= this.playerCount) {
					this.positionIndex = 0;
				}
				var player = this.getPlayer(this.positionIndex);
				if (!player.gameState.killed) {
					break;
				}
			}
			this.presidentIndex = this.positionIndex;
		}
		this.power = null;
	}

	this.finish = function() {
		console.log('FIN', this.gid);
		this.finished;
		//TODO save
	}

	this.enact = function(policy) {
		if (policy == LIBERAL) {
			++this.liberalEnacted;
			if (this.liberalEnacted >= LIBERAL_POLICIES_REQUIRED) {
				this.finish()
				return;
			}
		} else {
			++this.fascistEnacted;
			if (this.fascistEnacted >= FASCIST_POLICIES_REQUIRED) {
				this.finish()
				return;
			}
			this.power = this.getFascistPower();
			// console.log('enact power:', this.power);
		}
		if (!this.power) {
			this.advanceTurn();
		}
		return this.power;
	}

//PLAYERS

	this.addPlayer = function(socket) {
		socket.join(this.gid);

		var player = socket.player;
		player.game = this;
		player.disconnected = false;

		var adding = true;
		for (var pidx in this.players) {
			var gp = this.players[pidx];
			if (gp == player.uid) {
				adding = false;
				break;
			}
		}
		if (adding) {
			player.gameState = {};
			player.gameState.index = this.players.length;
			this.players[player.gameState.index] = player.uid;
		}

		if (this.isFull()) {
			this.start();
		} else {
			this.emit('lobby game', this.gameData());
		}
	}

	this.kill = function(player) {
		if (!player.gameState.killed) {
			player.gameState.killed = true;
			--this.currentCount;
		}
	}

	this.removeSelf = function() {
		var gid = this.gid;
		games = games.filter(function(game) {
			return game.gid != gid;
		});
	}

	this.disconnect = function(socket) {
		if (!this.started || this.finished) {
			this.remove(socket);
			return;
		}
		var player = socket.player;
		if (player) {
			player.disconnected = true;
		}
	}

	this.remove = function(socket) {
		socket.leave(this.gid);

		var player = socket.player;
		if (player.gameState.left) {
			return false;
		}
		if (this.started) {
			player.gameState.left = true;
			this.kill(player);
			if (this.presidentIndex == player.gameState.index || this.turn.chancellor == player.uid) {
				this.advanceTurn();
			}
		} else {
			this.players = this.players.filter(function(puid) {
				return puid != player.uid;
			});
			if (this.players.length == 0) {
				this.removeSelf()
			}
		}
		player.game = null;
		return true;
	}

//HELPERS

	this.getPlayer = function(index) {
		return Player.get(this.players[index]);
	}

	this.isFull = function() {
		return this.players.length >= this.maxSize;
	}

	this.isOpen = function() {
		return !this.started && !this.isFull();
	}

	this.activeCount = function() {
		var count = 0;
		this.players.forEach(function(puid) {
			var player = Player.get(puid);
			if (!player.disconnected) {
				++count;
			}
		});
		return count;
	}

	return this;
}

Game.games = games;

module.exports = Game;
