import { EventEmitter } from 'events';
import { PrologDebugSession } from './mockDebug';
import { StoppedEvent } from 'vscode-debugadapter/lib/debugSession';

// Added for Adapter Server
const debugLogger = require("electron-log");
var fs = require('fs');

const {spawn} = require('child_process');
const inputStream = require('stream');
//const {onExit} = require('@rauschma/stringio');

//const S = 14;


export class AdapterServer extends EventEmitter {

	private runtime;
	private tunnelLog;
	private rawInstructions;
	public instructionQueue;
	public inputStream;

	//private requestNum = 1;

	constructor() {
		super();
		this.tunnelLog = "";
		this.rawInstructions = [];
		this.instructionQueue = [];

		this.inputStream = new inputStream.Writable();


	}

	startServer() {
		var self = this;

		this.runtime = spawn("C:\\repcon4\\runtime\\bin\\repcon.exe",
							["-f", "c:\\repcon4\\repcon.properties",
							"-f", "c:\\repcon4\\runtime\\scripts\\erc_repcon_factory_session.rcf"],
							{shell: true});

		debugLogger.info("Runtime started.");
		this.runtime.stdin.setEncoding('utf-8');

/* 		this.runtime.on('exit', function (code, signal) {
			console.log(`Runtime exited with code ${code} and signal ${signal}`);
		}); */

		this.runtime.stdout.on('data', (data) => {
			//console.log(data);
			/* self.tunnelLog += data + "\n";
			let dataByLine = data.split(/\r?\n/);
			dataByLine.forEach(element => {
				if (element != "" && element != " ") {
					self.rawInstructions.push(element);
				}

			});
			if (self.parseInstructions()) {
				self.emit("newInstructions");
			} */

		});

		this.runtime.stderr.on('data', (data) => {
			let text = `${data}`;
			console.log(text);
			let dataByLine = text.split(/\r?\n/);
			dataByLine.forEach(element => {
				if (element != "" && element != " ") {
					self.rawInstructions.push(element);
				}
			});

			//self.rawInstructions.push(text);
			if (self.parseInstructions()) {
				self.emit("newInstructions");
			}

		});


		debugLogger.info("Runtime started.");
		CallStackInstruction.STATE = StackParseState.Parse;


	}
	sendUserInput(input) {
		this.sendRaw(input);
	}

	sendRaw(input) {

		//console.log("Sent to runtime: " + input);
		this.runtime.stdin.write(input + "\n");
		//this.runtime.stdin.end();


		this.tunnelLog += "---Sent to runtime:: " + input + "\n";
	}
	sendRequestStack() {
		//this.sendRaw("REQUEST " + this.requestNum++ + " stack");
	}

	parseInstructions() {
		while (this.rawInstructions.length > 0) {
			let curr = this.rawInstructions.shift();
			let onHold = [curr];
			// Merge all instructions together
			while (curr.substring(curr.length-2, curr.length) != "? ") {
				curr = this.rawInstructions.shift();
				if (curr == undefined) {

					//// very special case, cut the merge and execute
					let last = onHold[onHold.length-1];
					if (last.length > 3 && last.charAt(0) == "%") {
						let event1 = new InfoInstruction(onHold);
						this.instructionQueue.push(event1);
						return true;
					}
					//////////////////////////////////////////////

					onHold.reverse(); // TOD: substitute to make more eficcient
					onHold.forEach( el => {this.rawInstructions.unshift(el)}, );
					return false; // wait for more data;
				}

				if (curr.charAt(0) == "%") {
					// cut the merge
					this.rawInstructions.unshift(curr);
					let event1 = new InfoInstruction(onHold);
					this.instructionQueue.push(event1);
					return true;
				}

				onHold.push(curr); // after if important
			}

			// Exclude not relevant instructions
			for (var i = onHold.length-1; i >= 0; i--) {
				let line = onHold[i].charAt(0);
				if (line != " " && !isNaN(line)) {
					break;
				}
			}
			let extra = onHold.slice(0, i-1);
			let relevant = onHold.slice(i-1, onHold.length);
			let event1: DebugInstruction = new InfoInstruction(extra);
			let event2: DebugInstruction = new CallStackInstruction(relevant);

			if (extra.length > 0) {
				this.instructionQueue.push(event1, event2);
			} else {
				this.instructionQueue.push(event2);
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

class InfoInstruction extends DebugInstruction {

	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);
	}

	execute(session: PrologDebugSession) {
		if (this.raw.substring(this.raw.length-7, this.raw.length) == "(trace)") {
			CallStackInstruction.fixCallStack(session);
		}

		if (CallStackInstruction.STATE == StackParseState.Fix) {
			//return -1;
		}
		console.log(this);
		session.sendToClient("\n" + this.raw + "\n");
		return 1;
	}
}

class CallStackInstruction extends DebugInstruction {

	static STATE: StackParseState;

	callNum: Number;  //
	level: Number;   //
	action: StackAction // Call: Fail: Exit:
	fName: string; // restore(...)

	frameMarker: boolean;


	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);
		this.frameMarker = false;

		//|4      2 Call: |
		//|call(prolog:do_ex221153)),1),clpfd,[]))|

		//N S    23     F6 Call: T foo(hello,there,_123) ?

		let markers = lines[0]; // TODO: account for markers N S
		let noMarkers = lines.slice(1, lines.length).join("");
		let blocks = noMarkers.split(/\s+/g);

		// use @ to determine if CallStack-Fix is done
		var endFixState = false;
		if (CallStackInstruction.STATE == StackParseState.Fix) {
			if (blocks[0].charAt(0) == "@") {
				endFixState = true;
				blocks[0] = blocks[0].substring(1, blocks[0].length); // remove @
			}
		}
		this.callNum = parseInt(blocks[0]);

		let _level = parseInt(blocks[1]);
		if (_level == NaN) { // remove @
			this.frameMarker = true;
			_level = parseInt(blocks[1].substring(1, blocks[1].length));
		}
		this.level = _level;


		// TODO: add support for EXCEPTION and REDO action
		switch (blocks[2].charAt(0)) {
			case "C":
				this.action = StackAction.Call;
				break;
			case "E":
				this.action = StackAction.Exit;
				break;
			case "F":
				this.action = StackAction.Fail;
				break;
		}

		// account for subterm T marker
		if (blocks[3].charAt(0) == "^") {
			blocks.splice(3, 1);
		}

		this.fName = blocks[3].trim();

		if (endFixState) {
			CallStackInstruction.STATE = StackParseState.Parse;

			debugLogger.error("Ended CallStack Fix/Update");
		}

	}

	execute(session: PrologDebugSession) {
		session.sendToClient(this.raw + "\n");
		console.log("instruction level: " + this.level);
		console.log(this);
		//console.log(session.callStack);

		// Call stack instruction
		switch (this.action) {
			case StackAction.Call:
				if (this.level == session.callStack.length + 1) {
					session.callStack.push([this.fName, this.level]);
				}
				break;
			case StackAction.Fail:
			case StackAction.Exit:
				if (this.level <= session.callStack.length) {
					let curr = session.callStack.pop();
					while (curr[1] != this.level) {
						curr = session.callStack.pop()
					}
				}
				break;
		}
		session.sendEvent(new StoppedEvent('reply', PrologDebugSession.THREAD_ID));
		return 1;
	}

	static fixCallStack(session: PrologDebugSession) {
		this.STATE = StackParseState.Fix;
		session.adapterServer.sendRaw("g");
		session.callStack = new Array();
	}
}

enum StackAction {
	Call,
	Exit,
	Fail,
	Exception

}

enum StackParseState {
	Parse,
	Fix
}

