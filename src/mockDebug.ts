/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, ContinuedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, LoadedSourceEvent
} from 'vscode-debugadapter';

import { DebugProtocol} from 'vscode-debugprotocol';
import { basename } from 'path';
//import { MockRuntime, MockBreakpoint } from './mockRuntime';
import { AdapterServer, BasicBreakpoint } from './adapterServer';
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


	public _runtime: AdapterServer;
	public state = new Map();
	public callStack = new Array();
	public importedFiles = new Map();
	public hideAfterNext = false;
	public showOnConsole = true;
	public variables: Map<Number, Map<string, any>>;
	public varRetrieve: boolean = false;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */

	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new AdapterServer(this);


	}
	public customRequest(command: string, metadata, args?: any): Promise<DebugProtocol.Response> {
		switch (command) {
			case 'user_input':
				this.sendToDebugAdapter(args.msg as string);
				break;
			case 'importFile':
				let f = args as vscode.Uri;
				let s = new Source(f.path, f.path, this.importedFiles.entries.length, f.fsPath, f.scheme);
				this.importedFiles.set(f.path, s);
				this._runtime.setFile(s);
				let e = new LoadedSourceEvent('new', s);
				this.sendEvent(e);
				this._runtime.sendRaw("@");
				let cmd = `set_prolog_flag( redefine_warnings, off), ['${f.path.substring(1, f.path.length)}'].`;
				this._runtime.sendRaw(cmd);
				this.sendEvent(new StoppedEvent('step', PrologDebugSession.THREAD_ID));
				this._runtime.verifyBreakpoints();
				this._runtime.sendRaw("@");
				this._runtime.sendRaw("prolog:set_auto_binding(on).");
				break;
			case 'export_output':
				this._runtime.exportOutput();
				break;
			case 'remove_breakpoint':
				// handled already somewhere else

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
		this._configurationDone.notify();

	}

	public async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		this.setupServer(args.program);

		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path =<string>args.source.path!.replace(/\\/g, "/");
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		if (!args.breakpoints || args.breakpoints.length == 0) {
			this._runtime.clearBreakpoints(path);
			return;
		}
		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line), undefined, this.importedFiles.get(path));
			bp.id = id;
			return bp;
		});

		let onRuntime: Map<Number, BasicBreakpoint> = this._runtime.allBps;

		if (actualBreakpoints.length < onRuntime.size) {
			// remove pertinent
			onRuntime.forEach( (value, key, map) => {
				if (!actualBreakpoints.some( (val, index, arr) => {
					return val.id == key;
				})) {
					this._runtime.removeBreakpoint(key)
				}
				});

		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// prolog runtime only has one thread, always return dummy thread
		response.body = {
			threads: [
				new Thread(PrologDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		response.body = {
			stackFrames: this.callStack.map( s => new StackFrame(s[1], s[0], (s[3] ? this.createSource(s[3]) : undefined), s[2], undefined)),
			totalFrames: this.callStack.length
		}
		response.body.stackFrames = response.body.stackFrames.reverse();
		this.sendResponse(response);
		console.log("TRACE REQUEST PERFORMED");
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("" + frameReference), false));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		console.log("vars request");
		console.log(args);


		if (!this.variables) {
			this._runtime.sendRaw("@");
			this._runtime.sendRaw("prolog:set_auto_binding(on).");
		}
		const variables = new Array<DebugProtocol.Variable>();
		const id = this._variableHandles.get(args.variablesReference);
		if (id !== null) {
			let level = parseInt(id);
			let vars = this.variables.get(level);
			if (vars) {
				vars.forEach( (val, key, map) => {
					variables.push({
						name: key,
						type: "string",
						value: val,
						variablesReference: 0
					});
				});
			} else {
				variables.push({
					name: "?",
					type: "string",
					value: "not tracked in this call",
					variablesReference: 0
				});
			}

		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}
	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		//TODO: add action when hit pause button sendUserInput(x)
		this.sendResponse(response);
	}
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.skip();
		this.sendResponse(response);
	}
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.sendUserInput("o");
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		// TODO: add step back button to ui
		this._runtime.sendUserInput("r");
		this.sendResponse(response);
	}


	public setupServer(program?: string) {
		// Start adapter server to send/receive data
		this._runtime.startServer(true, program);
		this._runtime.on("newInstructions", () => {
			this.executeInstructions();
		})
		this._runtime.on('stopOnBreakpoint', (args) => {
			this.sendEvent(new StoppedEvent('breakpoint', PrologDebugSession.THREAD_ID, "Paused on a breakpoint"));
			let e = new OutputEvent('infoMessage', 'breakpoint', args);
			e.event = "infoMessage";
			this.sendEvent(e);
		});

		this._runtime.on('continue', () => {
			this.sendEvent(new ContinuedEvent(PrologDebugSession.THREAD_ID));
		});

		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', PrologDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnPause', () => {
			this.sendEvent(new StoppedEvent('pause', PrologDebugSession.THREAD_ID));
		});

		console.log("started the runtime");

		this.variables = new Map();

	}

	public executeInstructions() {

		while (this._runtime.instructionQueue.length > 0) {
			let curr = this._runtime.instructionQueue.shift();
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
		let e = new OutputEvent('runtimeOutput', 'user_error', { msg: message });
		e.event = "runtimeOutput";
		this.sendEvent(e);


	}

	public sendToDebugAdapter(input: string) {
		this._runtime.sendUserInput(input);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
		//return new Source(basename(filePath));

	}



}
