import { EventEmitter } from 'events';
import { PrologDebugSession } from './mockDebug';
import { StoppedEvent, Source } from 'vscode-debugadapter/lib/debugSession';
import { readFileSync } from 'fs';

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

	protected source_file: Source[];
	public _sourceFile: string[];

	public get sourceFile() {
		return this._sourceFile;
	}

	protected _sourceLines;
	public _currentLine: Number = 0;
	protected session;
	public breakpoints;
	public allBps;
	private _breakpointId = 1;;

	//private requestNum = 1;

	constructor(session: PrologDebugSession) {
		super();
		this.tunnelLog = "";
		this.rawInstructions = [];
		this.instructionQueue = [];

		this.inputStream = new inputStream.Writable();
		this.session = session;

		this.breakpoints = new Map<string, BasicBreakpoint[]>();
		this.allBps = new Map();

	}

	startServer(stopOnEntry: boolean, file?: string) {
		var self = this;

		if (file) {
			this._sourceFile = [file];
			this._sourceLines = readFileSync(this._sourceFile[0]).toString().split('\n');
		}

		this.process = spawn("C:\\repcon4\\runtime\\bin\\repcon.exe",
							["-f", "c:\\repcon4\\repcon.properties",
							"-f", "c:\\repcon4\\runtime\\scripts\\erc_repcon_factory_session.rcf"],
							{shell: true});

		debugLogger.info("Runtime started.");
		this.process.stdin.setEncoding('utf-8');

		this.process.stdout.on('data', (data) => {

		});

		this.process.stderr.on('data', (data) => {
			let text = `${data}`;
			console.log("|" + text + "|");
			this.session.sendToClient(text, true);
			this.tunnelLog += text;


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

		this.verifyBreakpoints();

		if (stopOnEntry) {
			// we step once
			this.sendEvent("stopOnEntry");
			console.log("stopped!!!!");
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
			console.log("not stopped!!!!");
		}





	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		// wait till next exception is found
		this.sendRaw("l");
		this.sendEvent("continue");
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(event = 'stopOnStep') {
		// cannot implement, no way of reading one line

		this.sendRaw("");
		this.sendEvent(event);
	}

	public skip() {
		this.sendRaw("s");

	}

	sendUserInput(input) {
		this.sendRaw(input);
	}

	sendRaw(input, lineBreak=true) {

		//console.log("Sent to runtime: " + input);
		this.process.stdin.write(input + "\n");
		this.session.sendToClient("\n", lineBreak);
		//this.runtime.stdin.end();


		this.tunnelLog += "---Sent to runtime:: " + input + "\n";
	}
	sendRequestStack() {
		//this.sendRaw("REQUEST " + this.requestNum++ + " stack");
	}

	askForVars() {
		if (CallStackInstruction.STATE == StackParseState.Parse) {
			this.sendRaw("v", false);
			this.session.showOnConsole = false;
		}

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
			if (onHold[i].substring(0, 9) == "Local var") {
				let event = new VariableInstruction(onHold);
				this.instructionQueue.push(event);
				return true;
			}
			//console.log(onHold);
			if (CallStackInstruction.STATE == StackParseState.Parse) {
				//let line = onHold[i].trim();
/* 				while (line.charAt(0) == "%") {
					line = onHold[++i].trim();
					while (line.charAt(0) != "%") {
						line = onHold[i++].trim();
					}
				} */

				let line = onHold[i].substring(0, 2).replace(/([?#])+/g, " ");
				while (line != "  ") {
					try {
						line = onHold[++i].substring(0, 2).replace(/([?#])+/g, " ");
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
		const bp = <BasicBreakpoint> { verified: false, line, id: this._breakpointId, path: path };
		let bps = this.breakpoints.get(path);
		if (!bps) {
			bps = new Array<BasicBreakpoint>();
			this.breakpoints.set(path, bps);

		}

		bp.verified = this.verifyBreakpoint(bp);

		let usedBp = bps.some( (val, index, arr) => {
			return val.line == bp.line;
		});

		if (!usedBp) {
			// send breakpoint command
			this.sendRaw("@");
			let cmd = `add_breakpoint( line( '${path}', ${line} ),   BID ).`.replace(/\\/g, "/");
			this.sendRaw(cmd);
			console.log(cmd);
			console.log("sent command for line " + bp.line);
			bps.push(bp);
			this.allBps.set(bp.id, bp);
			this._breakpointId++;

			if (true) {
				this.session.sendToClient("\n", true);
			}
		} else {

		}

		console.log(this.breakpoints);

		return bp;
	}

	private verifyBreakpoint( bp: BasicBreakpoint) {
		let path = bp.path;
		if (bp.line < 0) {
			return false;
		}
		let url = "/" + path.replace(/\\/g, "/");
		let val = this.session.importedFiles.has(url);
	    return val;

	}
	public verifyBreakpoints() {
		if (!this.allBps) {
			return;
		}
		this.allBps.forEach( (value, key, map) => {
			value.forEach( (val, index, arr) => {
				this.allBps[key][index].verified = this.verifyBreakpoint(this.allBps[key][index]);
			});
		});

	}

	public removeBreakpoint ( id:Number ) {
		let bp = this.allBps.get(id);
		this.allBps.delete(id);
		this.sendRaw("@");
		let cmd = `remove_breakpoints([${id}]).`;
		this.sendRaw(cmd);
		this.breakpoints.array.forEach((value, key, map) => {
			if (value.splice(this.allBps.indexOf(bp), 1).length > 0) {
				return;
			};
		});


	}

	public clearBreakpoints(path: string): void {
		this.breakpoints.delete(path);
		this.sendRaw("@");
		this.sendRaw("remove_breakpoints(all).");
		this._breakpointId = 1;
	}

	public setFile( file: Source ) {
		let len = this.source_file.push(file);
		this.source_file[len-1].name = this.source_file[len-1].path.substring(1, this.source_file[len-1].path.length);
		this._sourceFile.push(file.name);
		this._sourceLines = readFileSync(this.source_file[this.source_file.length-1].name).toString().split('\n');
		return true;
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	public fireEventsForLine(ln: number, file: string): boolean {

		//const line = this._sourceLines[ln].trim();
		this._currentLine = ln;

		// is there a breakpoint?
		let temp = this.source_file.path;
		temp = temp.substring(1, temp.length);
		temp = file;
		const breakpoints = this.breakpoints.get(temp);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				// send 'stopped' event

				this.sendEvent('stopOnBreakpoint', {line: ln, file: temp});



				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent('breakpointValidated', bps[0]);
				}
				return true;
			}
		}



		// nothing interesting found -> continue
		return false;
	}

	exportOutput() {
		fs.writeFile("src/tunnel_output.txt", this.tunnelLog, function(err) {});
		console.log("output saved!");

	}

	sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
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

	static previous: string = "";

	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);
		InfoInstruction.previous = raw;
	}

	execute(session: PrologDebugSession) {
/* 		if (this.raw.substring(this.raw.length-7, this.raw.length) == "(trace)") {
			CallStackInstruction.fixCallStack(session);
		} */

		if (CallStackInstruction.STATE == StackParseState.Fix) {
			//return -1;
		}
		//console.log(this, session);


		let temp = this.raw.trim();
		let print = true;

		if (temp.includes("No local var")) {
			session.variables.set(session.callStack.length, new Map());
			session.showOnConsole = true;

		}
		session.sendToClient("\n" + this.raw + "\n");



		if (temp.substring(temp.length-7, temp.length) == "(trace)" && DebugInstruction.count > 2) {
			session._runtime.sendRaw("g");
			session.hideAfterNext = true;
			session.sendEvent(new StoppedEvent('stopOnStep', PrologDebugSession.THREAD_ID));


		}

		if (temp.includes("No local var")) {
			session.variables.set(session.callStack.length, new Map());

		}

		return 1;
	}

	static gatherBreakpointInfo(): any {
		try {
			let temp = InfoInstruction.previous;
			if (temp.substring(0, 6) != "in sco") {
				return false;
			}
			temp = temp.substring(27, temp.length);
			let marker = temp.indexOf(" ");

			let line = parseInt(temp.substring(0, marker));
			if (line == NaN) {
				return false;
			}
			let file = temp.substring(marker + 4, temp.length);
			return { line: line, file: file };

		} catch (err) {
			console.log(err);
			return false;
		}



	}
}

export class CallStackInstruction extends DebugInstruction {

	static STATE: StackParseState;

	callNum: Number;  //
	level: Number;   //
	action: StackAction // Call: Fail: Exit:
	fName: string; // restore(...)

	frameMarker: boolean;
	breakpointEvt: boolean;


	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw, false);
		this.frameMarker = false;

		//|4      2 Call: |
		//|call(prolog:do_ex221153)),1),clpfd,[]))|

		//N S    23     F6 Call: T foo(hello,there,_123) ?
		this.breakpointEvt = false;
		let markers = lines[0]; // TODO: account for markers N S
		let temp = markers.trim().charAt(0);
		let noMarkers = "";

		if ("*?#+".includes(temp) || !isNaN(temp as any)) {
			//markers are merged
			markers = lines[0].substring(0, 8);
			noMarkers += lines[0].substring(8, lines[0].length);
		}
		noMarkers += lines.slice(1, lines.length).join("");

		// detect whether breakpoint event
		if (markers.includes("#")) {
			this.breakpointEvt = true;
		}


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

		// TODO: add support for EXCEPTION and REDO action, only CALL, FAIL, EXIT implemneted
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
					session.callStack.push([this.fName, this.level, undefined, undefined]);
					// Ask for variables stack
					session._runtime.askForVars();
				} else if (this.level < session.callStack.length + 1) {
					//// Added to solve breakpoint problem
					while (this.level < session.callStack.length + 1) {
						session.callStack.pop();
						session.variables.delete(session.callStack.length);
					}
					session.callStack.push([this.fName, this.level]);
					//session.adapterServer.askForVars();
					//////////////////////////////////////////////
				}
				break;
			case StackAction.Fail:
			case StackAction.Exit:
				if (this.level <= session.callStack.length) {
					let curr = session.callStack.pop();
					session.variables.delete(session.callStack.length);
					while (curr[1] != this.level) {
						curr = session.callStack.pop()
						session.variables.delete(session.callStack.length);
					}
				}
				break;
		}
		//session.sendEvent(new StoppedEvent('reply', PrologDebugSession.THREAD_ID));

		let response = InfoInstruction.gatherBreakpointInfo();
		if (this.breakpointEvt) {
			if (response != false) {
				session.callStack[session.callStack.length-1][2] = response.line;
				session.callStack[session.callStack.length-1][3] = response.file;
				session._runtime.fireEventsForLine(response.line, response.file);
			};
		} else {
			if (response != false) {
				session.callStack[session.callStack.length-1][2] = response.line;
				session._runtime.sendEvent('stopOnStep');
			} else {
				session._runtime.sendEvent('stopOnPause');
			}

		}

		if (!this.breakpointEvt) {

		}

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

export class VariableInstruction extends DebugInstruction {

	vars: Map<string, any>;

	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);
		let relevant = raw.substring(47, raw.length);
		let blocks = relevant.split(",");
		this.vars = new Map();
		blocks[blocks.length-1] = blocks[blocks.length-1].replace("?","");
		blocks.forEach(block => {
			let pair = block.split("=");
			this.vars.set(pair[0].trim(), pair[1].trim());
		});
	}

	execute(session: PrologDebugSession ) {
		let pairs = new Map();
		this.vars.forEach( (value, key, map) => {
			pairs.set(key, value);
		});
		session.variables.set(session.callStack.length, pairs);
		session._runtime.sendEvent('stopOnStep');
		session.showOnConsole = true;
		return 1;
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

export interface BasicBreakpoint {
	id: number;
	line: number;
	verified: boolean;
	path: string;
}

