import { EventEmitter } from 'events';
import { PrologDebugSession } from './mockDebug';
import { StoppedEvent } from 'vscode-debugadapter/lib/debugSession';

// Added for Adapter Server
const debugLogger = require("electron-log");
var fs = require('fs');

const {spawn} = require('child_process');
const {onExit} = require('@rauschma/stringio');

const S = 14;


export class AdapterServer extends EventEmitter {

	private server;
	private socket;
	private tunnelLog;
	private rawInstructions;
	public instructionQueue;

	private requestNum = 1;

	constructor() {
		super();
		this.server = null;
		this.socket = null;

		this.tunnelLog = "";
		this.rawInstructions = [];
		this.instructionQueue = [];

	}

	startServer() {
		var self = this;
		self.tunnelLog = "";



        debugLogger.info("Adapter server started.");

	}
	sendUserInput(input) {
		this.sendRaw("TUNNEL APPEND user_input " + input + "\0");
	}

	sendRaw(input) {
		this.socket.write(input + "\n");
		console.log("Sent to runtime: " + input);
		this.tunnelLog += "---Sent to runtime:: " + input + "\n";
	}
	sendRequestStack() {
		this.sendRaw("REQUEST " + this.requestNum++ + " stack");
	}

	parseInstructions() {
		while (this.rawInstructions.length > 0) {
			var curr = this.rawInstructions.shift();
			if (curr == "" || curr == " ") {continue;}
			let type = curr.substring(0, curr.indexOf(" "));
			var event: DebugInstruction;
			if (type == "debugEvents") {
				let mode = curr.substring(13, 19);
				if (mode == "STATUS" || mode == "DEBUGG") {
					if (this.rawInstructions.length < 2) { // wait, more data is needed
						this.rawInstructions.unshift(curr);
						return false;
					}
					let next = this.rawInstructions.shift() as string;
					event = new DebugEvent(curr, next);
					if (next.length > 13) { //if is not empty
						this.rawInstructions.shift();
						//console.log("skip 1");
					}
				} else {
					event = new DebugEvent(curr, "None");
				}
				this.instructionQueue.push(event);
			} else if (type == "toplevelEvents") {
				if (this.rawInstructions.length < 2) { // wait, more data is needed
					this.rawInstructions.unshift(curr);
					return false;
				}
				event = new TopLevelEvent(curr);
				this.rawInstructions.shift();
				this.instructionQueue.push(event);
			} else if (type == "user_error") {
				// Gather contiguous user_error instructions
				let lines = [curr];

				let text = curr.substring(10, curr.length).trim();
				if (text == "Call:" || text == "Fail:" || text == "Exit:") {

					if (this.rawInstructions.length < 1) { // wait, more data is needed
						this.rawInstructions.unshift(curr);
						return false;
					}
					let next = this.rawInstructions.shift() as string;
					lines.push(next);
				}
				/* let temp = this.rawInstructions.shift();
				while (temp.substring(0, 10) == "user_error") {
					lines.push(temp);
					temp = this.rawInstructions.shift();
				}
				this.rawInstructions.unshift(temp); */
				event = new UserError(lines);
				this.instructionQueue.push(event);
			}

		}
		return true;
	}




	exportOutput() {
		fs.writeFile("src/tunnel_output.txt", this.tunnelLog, function(err) {});
		console.log("output saved!");

	}
}

abstract class DebugInstruction {

	raw;

	constructor(rawData: string) {
		this.raw = rawData.trim();
		//console.log(rawData);
	}

	abstract execute(session: PrologDebugSession) : number;



}

class DebugEvent extends DebugInstruction {

	type; // debugEvent
	mode; // STATUS
	key; // compiling
	value; // compactcode

	// debugEvents STATUS compiling
	// debugEvents  compactcode .
	// debugEvents


	constructor(line1: string, line2: string) {
		super(line1 + ";" + line2);
		let blocks = line1.split(" ");
		this.type = blocks[0].trim();
		if (line2 == "None") {
			this.mode = "NO_MAP";
			this.key = "NONE";
			this.value = blocks[1]
		} else {
			this.mode = blocks[1].trim();
			this.key = blocks[2].trim();
			try {
				this.value = line2.split("  ")[1].replace(".", "").trim()
			} catch (err) {
				this.value = null;
			}
		}
	}


	execute(session: PrologDebugSession) {
		if (this.mode == "STATUS") {
			session.state.set(this.key, this.value);
		} else if (this.mode == "DEBUGGEREVENT" && this.key == "suspend") {
			session.adapterServer.sendRequestStack();

		} else if (this.mode == "REPLY") {
			// TODO: figure out what this instruction does
		} else {
			//Do nothing here
			return -1;
		}
		return 1;
	}
}

class TopLevelEvent extends DebugInstruction {

	type; // debugEvent
	mode; // STATUS
	key; // compiling
	value; // compactcode

	// toplevelEvents TOPLEVELEVENT ITEMS type%ide_message_event%functor%debug%term%debug(trace)
	// toplevelEvents

	constructor(line1: string) {
		super(line1);
		if (line1.trim().length <= 16) {
			// empty, defective instruction -> bypasss
			this.type = "topLevelEvent";
			this.mode = null;
			this.key = null;
			this.value = null;
			return;
		}

		let blocks = line1.split(" ");
		this.type = blocks[0].trim();
		this.mode = blocks[1].trim();
		this.key = blocks[2].trim();
		this.value = blocks[3].trim();
	}
	execute(session: PrologDebugSession) {
		if (this.mode == null) {
			// Bypass, do nothing
			debugLogger.error("Attempted to execute a defective instruction:: " + this.raw);
			return 0;
		}
		return 1;
	}
}

class UserError extends DebugInstruction {

	type;
	error_msg;

	stackFrameFlag: boolean;
	action: string; // Call: Fail: Exit:
	fName: string; // restore(...)
	level: Number;

	static callLevel: Number;


	//user_error 1
	//user_error       1
	//user_error  Call:
	//user_error restore('C:/repcon4/runtime/bin/rc_platform.sav')


	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);
		this.error_msg = raw.replace("user_error ", "").replace("user_error ", "");
		this.stackFrameFlag = false;

		if (lines.length > 1) {
			this.stackFrameFlag = true;
			this.action = lines[0].substring(10, lines[0].length).trim();
			this.fName = lines[1].substring(10, lines[1].length).trim();
			this.level = UserError.callLevel;
			//console.log(this);
		} else {
			let temp = this.error_msg.trim();
			if (!isNaN(temp)) {
				UserError.callLevel = parseInt(temp);
			}
		}
	}

	execute(session: PrologDebugSession) {
		// Print user_error to console
		//debugLogger.error(this.error_msg);
		session.sendToClient(this.error_msg);
		//console.log("instruction level: " + this.level);
		//console.log(session.callStack);

		// Call stack instruction
		if (this.stackFrameFlag) {
			//console.log("got in with action: " + this.action);
			switch (this.action) {
				case 'Call:':
					if (this.level == session.callStack.length + 1) {
						session.callStack.push([this.fName, this.level]);
					}
					break;
				case 'Fail:':
				case 'Exit:':
					if (this.level <= session.callStack.length) {
						let curr = session.callStack.pop();
						while (curr[1] != this.level) {
							curr = session.callStack.pop()
						}
					}
					break;
			}
			//console.log(session.callStack);
		}
		if (this.error_msg.trim() == "?") {
			session.sendEvent(new StoppedEvent('reply', PrologDebugSession.THREAD_ID));
		}
		return 1;
	}
}