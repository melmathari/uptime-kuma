const { Queue, Worker } = require("bullmq");
const { log } = require("../../src/util");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { R } = require("redbean-node");

/**
 * Redis-based queue manager for scaling monitor execution
 * Preserves existing monitor logic while enabling horizontal scaling
 */
class QueueManager {
    /**
     *
     */
    constructor() {
        this.redisConfig = {
            host: process.env.REDIS_HOST || "localhost",
            port: process.env.REDIS_PORT || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            db: process.env.REDIS_DB || 0,
            maxRetriesPerRequest: null, // Must be null for BullMQ
            retryDelayOnFailover: 100,
            enableReadyCheck: false,
            lazyConnect: true,
        };

        // Initialize queues
        this.monitorQueue = new Queue("monitor-checks", {
            connection: this.redisConfig,
            defaultJobOptions: {
                removeOnComplete: 100, // Keep last 100 completed jobs
                removeOnFail: 50,      // Keep last 50 failed jobs
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2000,
                },
            },
        });

        // Note: QueueScheduler is not needed in BullMQ v5+, scheduling is handled by Queue automatically

        // Worker to process monitor checks
        this.worker = new Worker("monitor-checks", this.processMonitorJob.bind(this), {
            connection: this.redisConfig,
            concurrency: parseInt(process.env.QUEUE_CONCURRENCY, 10) || 50, // Process up to 50 monitors concurrently
            limiter: {
                max: 1000,    // Max 1000 jobs per window
                duration: 60000, // 1-minute window
            },
        });

        this.setupEventListeners();
    }

    /**
     * Process a monitor check job - preserves existing Monitor.beat() logic
     * @param {object} job - BullMQ job object
     */
    async processMonitorJob(job) {
        const { monitorId } = job.data;

        try {
            log.debug("queue", `Processing monitor check for ID: ${monitorId}`);

            // Get monitor from database (same as existing logic)
            const monitor = await R.findOne("monitor", "id = ? AND active = 1", [ monitorId ]);

            if (!monitor) {
                log.warn("queue", `Monitor ${monitorId} not found or inactive`);
                return { status: "skipped",
                    reason: "monitor_not_found" };
            }

            // Get server instance for socket.io
            const server = UptimeKumaServer.getInstance();

            // Execute the existing beat logic
            await this.executeMonitorBeat(monitor, server.io);

            // Schedule next check (preserves interval-based scheduling)
            await this.scheduleNextCheck(monitor);

            return { status: "completed",
                monitorId };

        } catch (error) {
            log.error("queue", `Monitor ${monitorId} check failed:`, error);
            throw error; // Let BullMQ handle retries
        }
    }

    /**
     * Execute monitor beat using existing logic
     * @param {object} monitor - Monitor model instance
     * @param {object} io - Socket.io instance
     */
    async executeMonitorBeat(monitor, io) {
        // Import here to avoid circular dependencies
        const Monitor = require("../model/monitor");

        // Convert plain object to Monitor instance if needed
        const monitorInstance = Object.setPrototypeOf(monitor, Monitor.prototype);

        // Execute the core monitoring logic (this preserves ALL existing logic)
        await monitorInstance.performCheck(io);
    }

    /**
     * Schedule next monitor check
     * @param {object} monitor - Monitor configuration
     */
    async scheduleNextCheck(monitor) {
        const delay = (monitor.interval || 60) * 1000; // Convert to milliseconds

        await this.monitorQueue.add(
            `monitor-${monitor.id}`,
            { monitorId: monitor.id },
            {
                delay,
                jobId: `monitor-${monitor.id}-${Date.now()}`, // Unique job ID
            }
        );

        log.debug("queue", `Scheduled next check for monitor ${monitor.id} in ${delay}ms`);
    }

    /**
     * Start monitoring all active monitors
     */
    async startAllMonitors() {
        try {
            log.info("queue", "Starting all active monitors via queue system");

            const monitors = await R.find("monitor", "active = 1");

            // Clear any existing jobs for these monitors
            await this.monitorQueue.obliterate({ force: true });

            // Schedule immediate first check for all monitors
            const jobs = monitors.map(monitor => ({
                name: `monitor-${monitor.id}`,
                data: { monitorId: monitor.id },
                opts: {
                    delay: Math.random() * 10000, // Random delay 0-10s to spread load
                    jobId: `monitor-${monitor.id}-${Date.now()}`,
                }
            }));

            await this.monitorQueue.addBulk(jobs);

            log.info("queue", `Scheduled ${monitors.length} monitors for execution`);

        } catch (error) {
            log.error("queue", "Failed to start monitors:", error);
            throw error;
        }
    }

    /**
     * Stop monitoring a specific monitor
     * @param {number} monitorId - Monitor ID to stop
     */
    async stopMonitor(monitorId) {
        // Remove all pending jobs for this monitor
        const jobs = await this.monitorQueue.getJobs([ "waiting", "delayed" ], 0, -1);
        const monitorJobs = jobs.filter(job => job.data.monitorId === monitorId);

        for (const job of monitorJobs) {
            await job.remove();
        }

        log.info("queue", `Stopped monitoring for monitor ${monitorId}`);
    }

    /**
     * Setup event listeners for monitoring queue health
     */
    setupEventListeners() {
        this.worker.on("completed", (job) => {
            log.debug("queue", `Monitor check completed: ${job.data.monitorId}`);
        });

        this.worker.on("failed", (job, err) => {
            log.error("queue", `Monitor check failed: ${job.data.monitorId}`, err);
        });

        this.worker.on("stalled", (jobId) => {
            log.warn("queue", `Monitor check stalled: ${jobId}`);
        });

        this.monitorQueue.on("error", (err) => {
            log.error("queue", "Queue error:", err);
        });
    }

    /**
     * Get queue statistics
     */
    async getQueueStats() {
        return {
            waiting: await this.monitorQueue.getWaiting(),
            active: await this.monitorQueue.getActive(),
            completed: await this.monitorQueue.getCompleted(),
            failed: await this.monitorQueue.getFailed(),
        };
    }

    /**
     * Graceful shutdown
     */
    async close() {
        log.info("queue", "Shutting down queue manager");
        await this.worker.close();
        await this.monitorQueue.close();
    }
}

module.exports = { QueueManager };
