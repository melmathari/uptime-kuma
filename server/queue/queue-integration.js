const { QueueManager } = require("./queue-manager");
const { log } = require("../../src/util");

/**
 * Integration layer between existing server logic and Redis queue system
 * This allows switching between traditional setTimeout and Redis queue modes
 */
class QueueIntegration {
    /**
     *
     */
    constructor() {
        this.queueManager = null;
        this.isQueueMode = process.env.ENABLE_QUEUE_MODE === "true";
        this.isInitialized = false;
    }

    /**
     * Initialize the queue system if enabled
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isQueueMode && !this.isInitialized) {
            try {
                log.info("queue-integration", "Initializing Redis queue system");
                this.queueManager = new QueueManager();
                this.isInitialized = true;
                log.info("queue-integration", "Redis queue system initialized successfully");
            } catch (error) {
                log.error("queue-integration", "Failed to initialize queue system:", error);
                log.warn("queue-integration", "Falling back to traditional setTimeout mode");
                this.isQueueMode = false;
            }
        }
    }

    /**
     * Start all monitors using appropriate method (queue or traditional)
     * @param {object} io Socket.io instance
     * @returns {Promise<void>}
     */
    async startAllMonitors(io) {
        await this.initialize();

        if (this.isQueueMode && this.queueManager) {
            log.info("queue-integration", "Starting monitors via Redis queue");
            await this.queueManager.startAllMonitors();
        } else {
            log.info("queue-integration", "Starting monitors via traditional method");
            await this.startMonitorsTraditional(io);
        }
    }

    /**
     * Traditional monitor startup (preserves existing logic)
     * @param {object} io Socket.io instance
     * @returns {Promise<void>}
     */
    async startMonitorsTraditional(io) {
        const { R } = require("redbean-node");
        const { UptimeKumaServer } = require("../uptime-kuma-server");
        const { sleep, getRandomInt } = require("../../src/util");

        const server = UptimeKumaServer.getInstance();
        let list = await R.find("monitor", " active = 1 ");

        for (let monitor of list) {
            server.monitorList[monitor.id] = monitor;
        }

        for (let monitor of list) {
            try {
                await monitor.start(io);
            } catch (e) {
                log.error("monitor", e);
            }
            // Give some delays, so all monitors won't make request at the same moment when just start the server.
            await sleep(getRandomInt(300, 1000));
        }
    }

    /**
     * Start a specific monitor
     * @param {number} monitorId Monitor ID
     * @param {object} io Socket.io instance
     * @returns {Promise<void>}
     */
    async startMonitor(monitorId, io) {
        if (this.isQueueMode && this.queueManager) {
            // Schedule immediate check in queue
            await this.queueManager.monitorQueue.add(
                `monitor-${monitorId}`,
                { monitorId },
                { delay: 0 }
            );
            log.info("queue-integration", `Started monitor ${monitorId} via queue`);
        } else {
            // Use traditional method
            const { R } = require("redbean-node");
            const monitor = await R.findOne("monitor", "id = ?", [ monitorId ]);
            if (monitor) {
                await monitor.start(io);
            }
        }
    }

    /**
     * Stop a specific monitor
     * @param {number} monitorId Monitor ID
     * @returns {Promise<void>}
     */
    async stopMonitor(monitorId) {
        if (this.isQueueMode && this.queueManager) {
            await this.queueManager.stopMonitor(monitorId);
            log.info("queue-integration", `Stopped monitor ${monitorId} via queue`);
        } else {
            // Traditional stop logic
            const { UptimeKumaServer } = require("../uptime-kuma-server");
            const server = UptimeKumaServer.getInstance();

            if (server.monitorList[monitorId]) {
                await server.monitorList[monitorId].stop();
                delete server.monitorList[monitorId];
            }
        }
    }

    /**
     * Get monitoring statistics
     * @returns {Promise<object>}
     */
    async getStats() {
        if (this.isQueueMode && this.queueManager) {
            const queueStats = await this.queueManager.getQueueStats();
            return {
                mode: "queue",
                redis: true,
                ...queueStats
            };
        } else {
            const { UptimeKumaServer } = require("../uptime-kuma-server");
            const server = UptimeKumaServer.getInstance();

            return {
                mode: "traditional",
                redis: false,
                activeMonitors: Object.keys(server.monitorList).length
            };
        }
    }

    /**
     * Graceful shutdown
     * @returns {Promise<void>}
     */
    async shutdown() {
        if (this.queueManager) {
            await this.queueManager.close();
        }
    }

    /**
     * Health check for queue system
     * @returns {Promise<object>}
     */
    async healthCheck() {
        if (!this.isQueueMode) {
            return { status: "disabled",
                mode: "traditional" };
        }

        try {
            const stats = await this.getStats();
            return {
                status: "healthy",
                mode: "queue",
                stats
            };
        } catch (error) {
            return {
                status: "unhealthy",
                mode: "queue",
                error: error.message
            };
        }
    }
}

// Export singleton instance
const queueIntegration = new QueueIntegration();
module.exports = { queueIntegration,
    QueueIntegration };
