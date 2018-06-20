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
			let text = `${data}--`;
			console.log(text);
			let dataByLine = text.split(/\r?\n/);
			dataByLine.forEach(element => {
				if (element != "" && element != " ") {
					self.rawInstructions.push(element);
				}
			});

			//self.rawInstructions.push(text);
			/* if (self.parseInstructions()) {
				self.emit("newInstructions");
			} */

		});


		debugLogger.info("Runtime started.");


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
			while (curr.trim() != "?") {
				curr = this.rawInstructions.shift();
				onHold.push(curr);
			}








			if (curr == "" || curr == " ") {continue;}
			var event: DebugInstruction;

			// Gather contiguous user_error instructions
			let lines = [curr];
			let text = curr.substring(curr.length-6, curr.length);
			if (text == "Call:" || text == "Fail:" || text == "Exit:") {

				if (this.rawInstructions.length < 1) { // wait, more data is needed
					this.rawInstructions.unshift(curr);
					return false;
				}
				let next = this.rawInstructions.shift() as string;
				lines.push(next);
				let level = curr.substring(curr.length-8, curr.length-7) as Number;
				event = new UserError(lines, level);
			} else {
				event = new UserError(lines);
			}
			this.instructionQueue.push(event);
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

class StackInstruction extends DebugInstruction {

	callNum: Number;  //
	level: Number;   //
	action: string; // Call: Fail: Exit:
	fName: string; // restore(...)


	constructor(lines: string[]) {
		let raw = lines.join("");
		super(raw);

		//|4      2 Call: |
		//|call(prolog:do_ex221153)),1),clpfd,[]))|

		if (lines.length == 2) {
			this.action = lines[0].substring(lines[0].length-6, lines[0].length).trim();
			this.fName = lines[1].trim();
			//let blocks = lines[0].split()

		} else {
			// do something
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