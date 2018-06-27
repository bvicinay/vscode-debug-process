/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, LoadedSourceEvent
} from 'vscode-debugadapter';

import { DebugProtocol} from 'vscode-debugprotocol';
import { basename } from 'path';
import { MockRuntime, MockBreakpoint } from './mockRuntime';
import { AdapterServer, CallStackInstruction } from './adapterServer';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class PrologDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	public static THREAD_ID = 1;

	// a Mock runtime (or debugger)
	private _runtime: MockRuntime;

	public adapterServer: AdapterServer;
	public state = new Map();
	public callStack = new Array();
	public importedFiles = new Array<vscode.Uri>();
	public hideAfterNext = false;
	public showOnConsole = true;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */

	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MockRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}
	public customRequest(command: string, metadata, args?: any): Promise<DebugProtocol.Response> {
		switch (command) {
			case 'user_input':
				this.sendToDebugAdapter(args.msg as string);
				break;
			case 'raw_input':
				this.adapterServer.sendRaw(args.msg as string);
				break;
			case 'importFile':
				let f = args as vscode.Uri;
				this.importedFiles.push(f);
				let s = new Source(f.path, f.path, this.importedFiles.length, f.fsPath, f.scheme);
				let e = new LoadedSourceEvent('new', s);
				this.sendEvent(e);
				this.adapterServer.sendRaw("@");

				let cmd = `set_prolog_flag( redefine_warnings, off), ['${f.path.substring(1, f.path.length)}'].`;
				this.adapterServer.sendRaw(cmd);
				break;
			case 'export_output':
				this.adapterServer.exportOutput();


		}
		return new Promise(() => {});

	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notif
	}

	public async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		// Start runtime here
		this._runtime.start(args.program, !!args.stopOnEntry);

		this.setupServer();

		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		//this.adapterServer.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this.adapterServer.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id = id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(PrologDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		//const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		//const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		//const endFrame = startFrame + maxLevels;

		//const stk = this._runtime.stack(startFrame, endFrame);

		/* response.body = {
			stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count
		}; */
		//let temp = new StackFrame(50, "testCall", undefined, 25, undefined);
		response.body = {
			stackFrames: this.callStack.map( s => new StackFrame(s[1], s[0], undefined, undefined, undefined)),
			totalFrames: this.callStack.length
		}
		this.sendResponse(response);
		console.log("TRACE REQUEST PERFORMED");
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		const variables = new Array<DebugProtocol.Variable>();
		const id = this._variableHandles.get(args.variablesReference);
		if (id !== null) {
			variables.push({
				name: id + "_i",
				type: "integer",
				value: "123",
				variablesReference: 0
			});
			variables.push({
				name: id + "_f",
				type: "float",
				value: "3.14",
				variablesReference: 0
			});
			variables.push({
				name: id + "_s",
				type: "string",
				value: "hello world",
				variablesReference: 0
			});
			variables.push({
				name: id + "_o",
				type: "object",
				value: "Object",
				variablesReference: this._variableHandles.create("object_")
			});
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue(); //TODO: remove call on runtime
		this.adapterServer.sendUserInput("l");
		this.sendResponse(response);
	}
	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		//TODO: add action when hit pause button sendUserInput(x)
		this.sendResponse(response);
	}
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step(); // TODO: remove call on runtime
		this.adapterServer.sendUserInput("s");
		this.sendResponse(response);
	}
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.adapterServer.sendUserInput("");
		this.sendResponse(response);
	}
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.adapterServer.sendUserInput("o");
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		// TODO: add step back button to ui
		this.adapterServer.sendUserInput("r");
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		let reply: string | undefined = undefined;

		if (args.context === 'repl') {
			// 'evaluate' supports to create and delete breakpoints from the 'repl':
			const matches = /new +([0-9]+)/.exec(args.expression);
			if (matches && matches.length === 2) {
				const mbp = this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
				const bp = <DebugProtocol.Breakpoint> new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
				bp.id= mbp.id;
				this.sendEvent(new BreakpointEvent('new', bp));
				reply = `breakpoint created`;
			} else {
				const matches = /del +([0-9]+)/.exec(args.expression);
				if (matches && matches.length === 2) {
					const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
					if (mbp) {
						const bp = <DebugProtocol.Breakpoint> new Breakpoint(false);
						bp.id= mbp.id;
						this.sendEvent(new BreakpointEvent('removed', bp));
						reply = `breakpoint deleted`;
					}
				}
			}
		}

		response.body = {
			result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	public setupServer() {
		// Start adapter server to send/receive data
		this.adapterServer = new AdapterServer(this);
		this.adapterServer.startServer();
		this.adapterServer.on("newInstructions", () => {
			this.executeInstructions();
		})

		console.log("started the runtime");

	}

	public executeInstructions() {

		while (this.adapterServer.instructionQueue.length > 0) {
			let curr = this.adapterServer.instructionQueue.shift();
			curr.execute(this);
		}

	}

	public sendToClient(message: string, run?: boolean) {
		if (!this.showOnConsole || !run) {
			let b = new OutputEvent(message);
			this.sendEvent(b);
			return;
		}
		this.emit('user_error', message);
		//this.sendEvent(new OutputEvent(message, 'console', 'example'));
		//this.sendEvent(new BorjaCustomEvent("whaterver exampe", this));
		let e = new OutputEvent('runtimeOutput', 'user_error', { msg: message });
		e.event = "runtimeOutput";
		this.sendEvent(e);


		//console.log(e);

	}

	public sendToDebugAdapter(input: string) {
		this.adapterServer.sendUserInput(input);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		//return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
		return new Source(basename(filePath));

	}



}
/* class BorjaCustomEvent extends Event  implements vscode.DebugSessionCustomEvent {
	session: vscode.DebugSession;
	event: string;
	body: {
		text: string
	}
	public constructor(text: string, s: PrologDebugSession) {
		super('console');
		this.body.text = text;
		this.event = 'console';
		this.session = vscode.debug.activeDebugSession;
	}
} */



