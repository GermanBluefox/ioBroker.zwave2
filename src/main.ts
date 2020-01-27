// wotan-disable async-function-assignability

import * as utils from "@iobroker/adapter-core";
import * as fs from "fs-extra";
import * as path from "path";
import { Driver, ZWaveNode } from "zwave-js";
import { CommandClasses } from "zwave-js/build/lib/commandclass/CommandClasses";
import { HealNodeStatus } from "zwave-js/build/lib/controller/Controller";
import {
	ZWaveNodeMetadataUpdatedArgs,
	ZWaveNodeValueAddedArgs,
	ZWaveNodeValueRemovedArgs,
	ZWaveNodeValueUpdatedArgs,
} from "zwave-js/build/lib/node/Node";
import { ValueID } from "zwave-js/build/lib/node/ValueDB";
import { Global as _ } from "./lib/global";
import {
	computeChannelId,
	computeId,
	extendCC,
	extendMetadata,
	extendNode,
	extendValue,
	removeNode,
	removeValue,
	setNodeStatus,
} from "./lib/objects";
import {
	computeDeviceId,
	mapToRecord,
	NetworkHealPollResponse,
} from "./lib/shared";

export class ZWave2 extends utils.Adapter {
	public constructor(options: Partial<ioBroker.AdapterOptions> = {}) {
		super({
			...options,
			name: "zwave2",
			objects: true,
		});
		this.on("ready", this.onReady.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	declare oObjects: Exclude<ioBroker.Adapter["oObjects"], undefined>;

	private driver!: Driver;
	private driverReady = false;

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		// Make adapter instance global
		_.adapter = this;

		// Clear cache if we're asked to
		const cacheDir = path.join(
			utils.getAbsoluteInstanceDataDir(this),
			"cache",
		);
		if (!!this.config.clearCache) {
			// Remove cache dir if it exists
			await fs.remove(cacheDir);
			// Don't do that next time we start
			this.updateConfig({ clearCache: false });
			return;
		}

		await this.subscribeStatesAsync("*");

		// Reset all control states
		this.setState("info.connection", false, true);
		this.setState(`info.inclusion`, false, true);
		this.setState(`info.exclusion`, false, true);
		this.setState("info.healingNetwork", false, true);

		if (!this.config.serialport) {
			this.log.warn(
				"No serial port configured. Please select one in the adapter settings!",
			);
			return;
		}

		// Enable zwave-js logging
		if (this.config.writeLogFile) {
			process.env.LOGTOFILE = "true";
		}

		this.driver = new Driver(this.config.serialport, {
			cacheDir,
		});
		this.driver.once("driver ready", async () => {
			this.driverReady = true;
			this.setState("info.connection", true, true);

			this.log.info(
				`The driver is ready. Found ${this.driver.controller.nodes.size} nodes.`,
			);
			this.driver.controller
				.on("inclusion started", this.onInclusionStarted.bind(this))
				.on("exclusion started", this.onExclusionStarted.bind(this))
				.on("inclusion stopped", this.onInclusionStopped.bind(this))
				.on("exclusion stopped", this.onExclusionStopped.bind(this))
				.on("inclusion failed", this.onInclusionFailed.bind(this))
				.on("exclusion failed", this.onExclusionFailed.bind(this))
				.on("node added", this.onNodeAdded.bind(this))
				.on("node removed", this.onNodeRemoved.bind(this))
				.on(
					"heal network progress",
					this.onHealNetworkProgress.bind(this),
				)
				.on("heal network done", this.onHealNetworkDone.bind(this));

			for (const [nodeId, node] of this.driver.controller.nodes) {
				this.addNodeEventHandlers(node);
				// Reset the node status
				await this.setStateAsync(
					`${computeDeviceId(nodeId)}.status`,
					"unknown",
					true,
				);
			}

			// Now we know which nodes should exist - clean up orphaned nodes
			const nodeIdRegex = new RegExp(
				`^${this.name}\\.${this.instance}\\.Node_(\\d+)`,
			);
			const existingNodeIds = (Object.keys(
				await _.$$(`${this.namespace}.*`, { type: "device" }),
			)
				.map((id: string) => id.match(nodeIdRegex)?.[1])
				.filter(id => !!id) as string[])
				.map(id => parseInt(id, 10))
				.filter((id, index, all) => all.indexOf(id) === index);
			const unusedNodeIds = existingNodeIds.filter(
				id => !this.driver.controller.nodes.has(id),
			);
			for (const nodeId of unusedNodeIds) {
				this.log.warn(`Deleting orphaned node ${nodeId}`);
				await removeNode(nodeId);
			}
		});
		// Log errors from the Z-Wave lib
		this.driver.on("error", this.onZWaveError.bind(this));

		this.driver.once("all nodes ready", () => {
			this.log.info("All nodes are ready to use");
		});

		try {
			await this.driver.start();
		} catch (e) {
			this.log.error(
				`The Z-Wave driver could not be started: ${e.message}`,
			);
		}
	}

	private async onInclusionStarted(): Promise<void> {
		this.log.info("inclusion started");
		await this.setStateAsync("info.inclusion", true, true);
	}

	private async onExclusionStarted(): Promise<void> {
		this.log.info("exclusion started");
		await this.setStateAsync("info.exclusion", true, true);
	}

	private async onInclusionStopped(): Promise<void> {
		this.log.info("inclusion stopped");
		await this.setStateAsync("info.inclusion", false, true);
	}

	private async onExclusionStopped(): Promise<void> {
		this.log.info("exclusion stopped");
		await this.setStateAsync("info.exclusion", false, true);
	}

	private async onInclusionFailed(): Promise<void> {
		this.log.info("inclusion failed");
		await this.setStateAsync("info.inclusion", false, true);
	}

	private async onExclusionFailed(): Promise<void> {
		this.log.info("exclusion failed");
		await this.setStateAsync("info.exclusion", false, true);
	}

	private async onNodeAdded(node: ZWaveNode): Promise<void> {
		this.log.info(`Node ${node.id}: added`);
		this.addNodeEventHandlers(node);
	}

	private async onNodeRemoved(node: ZWaveNode): Promise<void> {
		this.log.info(`Node ${node.id}: removed`);
		node.removeAllListeners();

		await removeNode(node.id);
	}

	private async onHealNetworkProgress(
		progress: ReadonlyMap<number, HealNodeStatus>,
	): Promise<void> {
		const allDone = [...progress.values()].every(v => v !== "pending");
		// If this is the final progress report, skip it, so the frontend gets the "done" message
		if (allDone) return;
		this.respondToHealNetworkPoll({
			type: "progress",
			progress: mapToRecord(progress),
		});
	}

	private async onHealNetworkDone(
		result: ReadonlyMap<number, HealNodeStatus>,
	): Promise<void> {
		this.respondToHealNetworkPoll({
			type: "done",
			progress: mapToRecord(result),
		});
		this.setState("info.healingNetwork", false, true);
	}

	private addNodeEventHandlers(node: ZWaveNode): void {
		node.once("ready", this.onNodeReady.bind(this))
			.once(
				"interview completed",
				this.onNodeInterviewCompleted.bind(this),
			)
			.on("wake up", this.onNodeWakeUp.bind(this))
			.on("sleep", this.onNodeSleep.bind(this))
			.on("alive", this.onNodeAlive.bind(this))
			.on("dead", this.onNodeDead.bind(this))
			.on("value added", this.onNodeValueAdded.bind(this))
			.on("value updated", this.onNodeValueUpdated.bind(this))
			.on("value removed", this.onNodeValueRemoved.bind(this))
			.on("metadata updated", this.onNodeMetadataUpdated.bind(this));
	}

	private async onNodeReady(node: ZWaveNode): Promise<void> {
		this.log.info(`Node ${node.id}: ready to use`);
		if (node.isControllerNode()) return;

		const nodeAbsoluteId = `${this.namespace}.${computeDeviceId(node.id)}`;

		// Make sure the device object exists and is up to date
		await extendNode(node);

		// Set the node status
		await setNodeStatus(
			node.id,
			node.supportsCC(CommandClasses["Wake Up"]) ? "awake" : "alive",
		);

		// Find out which channels and states need to exist
		const allValueIDs = node.getDefinedValueIDs();
		const uniqueCCs = allValueIDs
			.map(vid => [vid.commandClass, vid.commandClassName] as const)
			.filter(
				([cc], index, arr) =>
					arr.findIndex(([_cc]) => _cc === cc) === index,
			);
		const desiredChannelIds = new Set(
			uniqueCCs.map(
				([, ccName]) =>
					`${this.namespace}.${computeChannelId(node.id, ccName)}`,
			),
		);
		const existingChannelIds = Object.keys(
			await _.$$(`${nodeAbsoluteId}.*`, {
				type: "channel",
			}),
		);
		const desiredStateIds = new Set(
			allValueIDs.map(
				vid => `${this.namespace}.${computeId(node.id, vid)}`,
			),
		);
		const existingStateIds = Object.keys(
			await _.$$(`${nodeAbsoluteId}.*`, {
				type: "state",
			}),
		);

		// Clean up unused channels and states
		const unusedChannels = existingChannelIds.filter(
			id => !desiredChannelIds.has(id),
		);
		for (const id of unusedChannels) {
			this.log.warn(`Deleting orphaned channel ${id}`);
			try {
				await this.delObjectAsync(id);
			} catch (e) {
				/* it's fine */
			}
		}

		const unusedStates = existingStateIds
			// select those states that are not desired
			.filter(id => !desiredStateIds.has(id))
			// filter out those states that are not under a CC channel
			.filter(id => id.slice(nodeAbsoluteId.length + 1).includes("."));

		for (const id of unusedStates) {
			this.log.warn(`Deleting orphaned state ${id}`);
			try {
				await this.delStateAsync(id);
			} catch (e) {
				/* it's fine */
			}
			try {
				await this.delObjectAsync(id);
			} catch (e) {
				/* it's fine */
			}
		}

		// Make sure all channel objects are up to date
		for (const [cc, ccName] of uniqueCCs) {
			await extendCC(node, cc, ccName);
		}

		// Prepare data points for all the node's values
		for (const valueId of allValueIDs) {
			const value = node.getValue(valueId);
			await extendValue(node, {
				...valueId,
				newValue: value,
			});
		}
	}

	private async onNodeInterviewCompleted(node: ZWaveNode): Promise<void> {
		this.log.info(
			`Node ${node.id}: interview completed, all values are updated`,
		);
	}

	private async onNodeWakeUp(node: ZWaveNode): Promise<void> {
		await setNodeStatus(node.id, "awake");
		this.log.info(`Node ${node.id}: is now awake`);
	}

	private async onNodeSleep(node: ZWaveNode): Promise<void> {
		await setNodeStatus(node.id, "asleep");
		this.log.info(`Node ${node.id}: is now asleep`);
	}

	private async onNodeAlive(node: ZWaveNode): Promise<void> {
		await setNodeStatus(node.id, "alive");
		this.log.info(`Node ${node.id}: has returned from the dead`);
	}

	private async onNodeDead(node: ZWaveNode): Promise<void> {
		await setNodeStatus(node.id, "dead");
		this.log.info(`Node ${node.id}: is now dead`);
	}

	private async onNodeValueAdded(
		node: ZWaveNode,
		args: ZWaveNodeValueAddedArgs,
	): Promise<void> {
		let propertyName = computeId(node.id, args);
		propertyName = propertyName.substr(propertyName.lastIndexOf(".") + 1);
		this.log.debug(
			`Node ${node.id}: value added: ${propertyName} => ${args.newValue}`,
		);
		await extendValue(node, args);
	}

	private async onNodeValueUpdated(
		node: ZWaveNode,
		args: ZWaveNodeValueUpdatedArgs,
	): Promise<void> {
		let propertyName = computeId(node.id, args);
		propertyName = propertyName.substr(propertyName.lastIndexOf(".") + 1);
		this.log.debug(
			`Node ${node.id}: value updated: ${propertyName} => ${args.newValue}`,
		);
		await extendValue(node, args);
	}

	private async onNodeValueRemoved(
		node: ZWaveNode,
		args: ZWaveNodeValueRemovedArgs,
	): Promise<void> {
		let propertyName = computeId(node.id, args);
		propertyName = propertyName.substr(propertyName.lastIndexOf(".") + 1);
		this.log.debug(`Node ${node.id}: value removed: ${propertyName}`);
		await removeValue(node.id, args);
	}

	private async onNodeMetadataUpdated(
		node: ZWaveNode,
		args: ZWaveNodeMetadataUpdatedArgs,
	): Promise<void> {
		let propertyName = computeId(node.id, args);
		propertyName = propertyName.substr(propertyName.lastIndexOf(".") + 1);
		this.log.debug(`Node ${node.id}: metadata updated: ${propertyName}`);
		await extendMetadata(node, args);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 */
	private async onUnload(callback: () => void): Promise<void> {
		try {
			this.log.info("Shutting down driver...");
			await this.driver.destroy();
			this.log.info("Cleaned everything up!");
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called when the Z-Wave lib has a non-critical error
	 */
	private async onZWaveError(error: Error): Promise<void> {
		this.log.error(error.message);
	}

	/**
	 * Is called if a subscribed object changes
	 */
	private onObjectChange(
		id: string,
		obj: ioBroker.Object | null | undefined,
	): void {
		if (obj) {
			// The object was changed
			this.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			this.log.debug(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 */
	private async onStateChange(
		id: string,
		state: ioBroker.State | null | undefined,
	): Promise<void> {
		if (state) {
			// The state was changed
			if (!state.ack) {
				// Handle some special states first
				if (id.endsWith("info.inclusion")) {
					if (state.val) await this.setExclusionMode(false);
					await this.setInclusionMode(state.val);
					return;
				} else if (id.endsWith("info.exclusion")) {
					if (state.val) await this.setInclusionMode(false);
					await this.setExclusionMode(state.val);
					return;
				}

				// Otherwise perform the default handling for values
				const obj = this.oObjects[id];
				if (!obj) {
					this.log.error(
						`Object definition for state ${id} is missing!`,
					);
					// TODO: Capture this with sentry?
					return;
				}

				const { native } = obj;
				const nodeId: number | undefined = native.nodeId;
				if (!nodeId) {
					this.log.error(
						`Node ID missing from object definition ${id}!`,
					);
					return;
				}
				const valueId: ValueID | undefined = native.valueId;
				if (!(valueId && valueId.commandClass && valueId.property)) {
					this.log.error(
						`Value ID missing or incomplete in object definition ${id}!`,
					);
					return;
				}
				const node = this.driver.controller.nodes.get(nodeId);
				if (!node) {
					this.log.error(`Node ${nodeId} does not exist!`);
					return;
				}

				try {
					await node.setValue(valueId, state.val);
					await this.setStateAsync(id, state.val, true);
				} catch (e) {
					this.log.error(e.message);
				}
			}
		} /* else {
			// The state was deleted
		} */
	}

	private async setInclusionMode(active: boolean): Promise<void> {
		try {
			if (active) {
				await this.driver.controller.beginInclusion();
			} else {
				await this.driver.controller.stopInclusion();
			}
		} catch (e) {
			/* nothing to do */
		}
	}

	private async setExclusionMode(active: boolean): Promise<void> {
		try {
			if (active) {
				await this.driver.controller.beginExclusion();
			} else {
				await this.driver.controller.stopExclusion();
			}
		} catch (e) {
			/* nothing to do */
		}
	}

	// This is used to store responses if something changed between two calls
	private healNetworkPollResponse: NetworkHealPollResponse | undefined;
	// This is used to store the callback if there was no response yet
	private healNetworkPollCallback:
		| ((response: NetworkHealPollResponse) => void)
		| undefined;

	/** Responds to a pending poll from the frontend (if there is a message outstanding) */
	private respondToHealNetworkPoll(response: NetworkHealPollResponse): void {
		if (typeof this.healNetworkPollCallback === "function") {
			// If the client is waiting for a response, send it immediately
			this.healNetworkPollCallback(response);
			this.healNetworkPollCallback = undefined;
		} else {
			// otherwise remember the response for the next call
			this.healNetworkPollResponse = response;
		}
	}

	/**
	 * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	 * Using this method requires "common.message" property to be set to true in io-package.json
	 */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		// responds to the adapter that sent the original message
		const respond = (response: any): void => {
			// wotan-disable-next-line no-useless-predicate
			if (obj.callback)
				this.sendTo(obj.from, obj.command, response, obj.callback);
		};
		// some predefined responses so we only have to define them once
		const responses = {
			ACK: { error: null },
			OK: { error: null, result: "ok" },
			ERROR_UNKNOWN_COMMAND: { error: "Unknown command!" },
			MISSING_PARAMETER: (paramName: string) => {
				return { error: 'missing parameter "' + paramName + '"!' };
			},
			COMMAND_ACTIVE: { error: "command already active" },
			RESULT: (result: unknown) => ({ error: null, result }),
			ERROR: (error: string) => ({ error }),
		};
		// make required parameters easier
		// function requireParams(...params: string[]): boolean {
		// 	if (!params.length) return true;
		// 	for (const param of params) {
		// 		if (!(obj.message && obj.message.hasOwnProperty(param))) {
		// 			respond(responses.MISSING_PARAMETER(param));
		// 			return false;
		// 		}
		// 	}
		// 	return true;
		// }
		// wotan-disable-next-line no-useless-predicate
		if (obj) {
			switch (obj.command) {
				case "getNetworkMap": {
					if (!this.driverReady) {
						return respond(
							responses.ERROR(
								"The driver is not yet ready to show the network map!",
							),
						);
					}

					const map = [...this.driver.controller.nodes.values()].map(
						node => ({
							id: node.id,
							name: `Node ${node.id}`,
							neighbors: node.neighbors,
						}),
					);
					respond(responses.RESULT(map));
					return;
				}

				case "getSerialPorts": {
					try {
						const ports = await Driver.enumerateSerialPorts();
						respond(responses.RESULT(ports));
					} catch (e) {
						if (e.code === "ENOENT" && /udevadm/.test(e.message)) {
							// This can happen on linux, however serialport does not handle the error
							respond(
								responses.ERROR(
									"udevadm was not found on PATH",
								),
							);
							this.log.warn(
								`Cannot list serial ports because "udevadm" was not found on PATH!`,
							);
							this.log.warn(
								`If it is installed, add it to the PATH env variable.`,
							);
							this.log.warn(
								`Otherwise, install it using "apt install udev"`,
							);
						} else {
							respond(responses.ERROR(e.message));
						}
					}
					return;
				}

				case "beginHealingNetwork": {
					if (!this.driverReady) {
						return respond(
							responses.ERROR(
								"The driver is not yet ready to heal the network!",
							),
						);
					}

					const result = this.driver.controller.beginHealingNetwork();
					if (result) {
						respond(responses.OK);
						this.setState("info.healingNetwork", true, true);
					} else {
						respond(responses.COMMAND_ACTIVE);
					}
					return;
				}

				case "stopHealingNetwork": {
					if (!this.driverReady) {
						return respond(
							responses.ERROR(
								"The driver is not yet ready to heal the network!",
							),
						);
					}

					this.driver.controller.stopHealingNetwork();
					respond(responses.OK);
					this.setState("info.healingNetwork", false, true);
					return;
				}

				case "healNetworkPoll": {
					if (this.healNetworkPollResponse) {
						// if a response is waiting to be asked for, send it immediately
						respond(responses.RESULT(this.healNetworkPollResponse));
						this.healNetworkPollResponse = undefined;
					} else {
						// otherwise remember the callback for a later response
						this.respondToHealNetworkPoll = result =>
							respond(responses.RESULT(result));
					}

					return;
				}

				case "clearCache": {
					this.updateConfig({ clearCache: true });
					respond(responses.OK);
					return;
				}
			}
		}
	}
}

if (module.parent) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<ioBroker.AdapterOptions> | undefined) =>
		new ZWave2(options);
} else {
	// otherwise start the instance directly
	(() => new ZWave2())();
}

process.on("unhandledRejection", r => {
	throw r;
});
