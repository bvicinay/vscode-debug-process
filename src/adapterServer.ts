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

	private process;
	private tunnelLog;
	private rawInstructions;
	public instructionQueue;
	public inputStream;

	protected session;
	public breakpoints;
	private _breakpointId;

	//private requestNum = 1;

	constructor(session: PrologDebugSession) {
		super();
		this.tunnelLog = "";
		this.rawInstructions = [];
		this.instructionQueue = [];

		this.inputStream = new inputStream.Writable();
		this.session = session;

		this.breakpoints = new Map<string, BasicBreakpoint[]>();
		this._breakpointId = 1;


	}

	startServer() {
		var self = this;

		this.process = spawn("C:\\repcon4\\runtime\\bin\\repcon.exe",
							["-f", "c:\\repcon4\\repcon.properties",
							"-f", "c:\\repcon4\\runtime\\scripts\\erc_repcon_factory_session.rcf"],
							{shell: true});

		debugLogger.info("Runtime started.");
		this.process.stdin.setEncoding('utf-8');

/* 		this.runtime.on('exit', function (code, signal) {
			console.log(`Runtime exited with code ${code} and signal ${signal}`);
		}); */

		this.process.stdout.on('data', (data) => {
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

		this.process.stderr.on('data', (data) => {
			let text = `${data}`;
			console.log("|" + text + "|");
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
		this.process.stdin.write(input + "\n");
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

			if (curr.trim() == "Ancestors:" && CallStackInstruction.STATE != StackParseState.Fix) {
				CallStackInstruction.STATE = StackParseState.Fix;
				let msgEvt = new InfoInstruction([curr]);
				msgEvt.execute(this.session); // no need to add to queue
				//onHold = [];
			} else if (curr == "| :- ") {
				CallStackInstruction.STATE = StackParseState.Ignore;
			}

			if (CallStackInstruction.STATE == StackParseState.Ignore) {
				let msgEvt = new InfoInstruction([curr]);
				msgEvt.execute(this.session); // no need to add to queue
				console.log("stil here");
				if (curr.substring(curr.length-2, curr.length) != "? ") {
					CallStackInstruction.STATE = StackParseState.Parse;
				}
				return true;
			}


			// Merge all instructions together
			while (curr.substring(curr.length-2, curr.length) != "? ") {
				curr = this.rawInstructions.shift();
				if (curr == undefined) {

					//// very special case, cut the merge and execute
					let last = onHold[onHold.length-1];
					if (last.length > 3 && (last.charAt(0) == "%" || last.charAt(last.length-2) == "?")) {
						let event1 = new InfoInstruction(onHold);
						this.instructionQueue.push(event1);
						return true;
					}
					//////////////////////////////////////////////

					onHold.reverse(); // TOD: substitute to make more eficcient
					onHold.forEach( el => {this.rawInstructions.unshift(el)}, );
					return false; // wait for more data;
				}

				if (curr.trim().charAt(0) == "%" || curr.trim().charAt(0) == "!") {
					// cut the merge
					this.rawInstructions.unshift(curr);
					let event1 = new InfoInstruction(onHold);
					this.instructionQueue.push(event1);
					return this.parseInstructions();
				}

				onHold.push(curr); // after if important

			}

			// Exclude not relevant instructions
			var i = 0;
			//console.log(onHold);
			if (CallStackInstruction.STATE == StackParseState.Parse) {
				//let line = onHold[i].trim();
/* 				while (line.charAt(0) == "%") {
					line = onHold[++i].trim();
					while (line.charAt(0) != "%") {
						line = onHold[i++].trim();
					}
				} */
				let line = onHold[i].substring(0, 2).replace("?", " ");
				while (line != "  ") {
					try {
						line = onHold[++i].substring(0, 2).replace("?", " ");
					} catch (err) {
						break;
					}

				}

			}
			if (CallStackInstruction.STATE == StackParseState.Fix) {
				debugLogger.warn("ENTERING CALL STACK FIX STATE");
				CallStackInstruction.fixCallStack(onHold.splice(1, onHold.length), this.session);
				CallStackInstruction.STATE = StackParseState.Parse;
				this.session.showOnConsole = true;
				return true;
			}

			let extra = onHold.slice(0, i);
			let relevant = onHold.slice(i, onHold.length);
			console.log(extra, relevant);
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

	public setBreakPoint(path: string, line: number) : BasicBreakpoint {

		const bp = <BasicBreakpoint> { verified: false, line, id: this._breakpointId++ };
		let bps = this.breakpoints.get(path);
		if (!bps) {
			bps = new Array<BasicBreakpoint>();
			this.breakpoints.set(path, bps);
		}

		bp.verified = this.verifyBreakpoint(bp);
		if (!bps.includes(bp)) {
			// send breakpoint command
			this.sendRaw("@");
			let cmd = `add_breakpoint( line( '${path}', ${line} ),   BID ).`.replace(/\\/g, "/");
			this.sendRaw(cmd);
			console.log(cmd);
			console.log("sent command for line " + bp.line);
			bps.push(bp);
		}

		console.log(this.breakpoints);

		return bp;
	}

	private verifyBreakpoint( bp: BasicBreakpoint ) {
		return true; // TODO: implement breakpoint verification of some sort
	}

	public clearBreakpoints(path: string): void {
		this.breakpoints.delete(path);
	}




	exportOutput() {
		fs.writeFile("src/tunnel_output.txt", this.tunnelLog, function(err) {});
		console.log("output saved!");

	}
}

abstract class DebugInstruction {

	raw;
	static count = 0;

	constructor(rawData: string, trim?: boolean) {
		if (trim) {
			rawData = rawData.trim()
		}
		this.raw = rawData;
		DebugInstruction.count++;
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
/* 		if (this.raw.substring(this.raw.length-7, this.raw.length) == "(trace)") {
			CallStackInstruction.fixCallStack(session);
		} */

		if (CallStackInstruction.STATE == StackParseState.Fix) {
			//return -1;
		}
		//console.log(this, session);
		session.sendToClient("\n" + this.raw + "\n");

		let temp = this.raw.trim();
		if (temp.substring(temp.length-7, temp.length) == "(trace)" && DebugInstruction.count > 2) {
			session.adapterServer.sendRaw("g");
			session.hideAfterNext = true;

		}

		return 1;
	}
}

export class CallStackInstruction extends DebugInstruction {

	static STATE: StackParseState;

	callNum: Number;  //
	level: Number;   //
	action: StackAction // Call: Fail: Exit:
	fName: string; // restore(...)

	frameMarker: boolean;


	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw, false);
		this.frameMarker = false;

		//|4      2 Call: |
		//|call(prolog:do_ex221153)),1),clpfd,[]))|

		//N S    23     F6 Call: T foo(hello,there,_123) ?

		let markers = lines[0]; // TODO: account for markers N S
		let temp = markers.trim().charAt(0);
		let noMarkers = "";

		if ("*?#+".includes(temp) || !isNaN(temp as any)) {
			//markers are merged
			markers = lines[0].substring(0, 8);
			noMarkers += lines[0].substring(8, lines[0].length);
		}
		noMarkers += lines.slice(1, lines.length).join("");


		let blocks = noMarkers.split(/\s+/g);

		// use @ to determine if CallStack-Fix is done
		if (CallStackInstruction.STATE == StackParseState.Fix) {
			if (blocks[0].charAt(0) == "@") {
				this.frameMarker = true;
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

		try {
			blocks[2].charAt(0);
		} catch (err) {
			console.log(this);
			console.log(lines);
			console.log(err);

		}

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


	}

	execute(session: PrologDebugSession) {
		session.sendToClient(this.raw + "\n");

		if (session.hideAfterNext) {
			session.showOnConsole = false;
			session.hideAfterNext = false;
		}


		//console.log("instruction level: " + this.level);
		//console.log(this);
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

 	static fixCallStack(stackLines: string[], session: PrologDebugSession) {
		session.callStack = new Array();
		let merged = new Array<string>();
		// merge ? if needed
		if (stackLines[stackLines.length-1] == " ? ") {
			stackLines[stackLines.length-2] += stackLines[stackLines.length-1];
			stackLines.pop();
		}
		// merge markers by call
		while (stackLines.length != 0) {
			let el = stackLines.shift();
			if (!el) {
				console.log("Something went wrong!");
				return;
			}
			while (el.length <= 23) {
				el += stackLines.shift();
			}
			merged.push(el);
		}
		merged.forEach( el =>  {
			// split markers area
			for (var i = 0; i < el.length; i++) {
				if (!" ?+*#".includes(el.charAt(i))) {
					break;
				}
			}
			let lines = [el.substring(0, i), el.substring(i, el.length)];
			let event = new CallStackInstruction(lines);
			event.execute(session);
		})


	}
}

enum StackAction {
	Call,
	Exit,
	Fail,
	Exception

}

export enum StackParseState {
	Parse,
	Fix,
	Ignore
}

interface BasicBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

