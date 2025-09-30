const { MonitorType } = require("./monitor-type");
const { chromium } = require("playwright-core");
const { UP, log } = require("../../src/util");
const { Settings } = require("../settings");
const commandExistsSync = require("command-exists").sync;
const childProcess = require("child_process");
const path = require("path");
const Database = require("../database");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { RemoteBrowser } = require("../remote-browser");

/**
 * Cached instance of a browser
 * @type {import ("playwright-core").Browser}
 */
let browser = null;

let allowedList = [];
let lastAutoDetectChromeExecutable = null;

if (process.platform === "win32") {
    allowedList.push(process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Google\\Chrome\\Application\\chrome.exe");

    // Allow Chromium too
    allowedList.push(process.env.LOCALAPPDATA + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Chromium\\Application\\chrome.exe");

    // Allow MS Edge
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe");

    // For Loop A to Z
    for (let i = 65; i <= 90; i++) {
        let drive = String.fromCharCode(i);
        allowedList.push(drive + ":\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        allowedList.push(drive + ":\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    }

} else if (process.platform === "linux") {
    allowedList = [
        "chromium",
        "chromium-browser",
        "google-chrome",

        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium",           // Ubuntu
    ];
} else if (process.platform === "darwin") {
    allowedList = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
}

/**
 * Is the executable path allowed?
 * @param {string} executablePath Path to executable
 * @returns {Promise<boolean>} The executable is allowed?
 */
async function isAllowedChromeExecutable(executablePath) {
    console.log(config.args);
    if (config.args["allow-all-chrome-exec"] || process.env.UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC === "1") {
        return true;
    }

    // Check if the executablePath is in the list of allowed executables
    return allowedList.includes(executablePath);
}

/**
 * Get the current instance of the browser. If there isn't one, create
 * it.
 * @returns {Promise<import ("playwright-core").Browser>} The browser
 */
async function getBrowser() {
    if (browser && browser.isConnected()) {
        return browser;
    } else {
        let executablePath = await Settings.get("chromeExecutable");

        executablePath = await prepareChromeExecutable(executablePath);

        browser = await chromium.launch({
            //headless: false,
            executablePath,
            args: [
                '--enable-video-capture-use-gpu',
                '--enable-web-rtc-hw-encoding',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });

        return browser;
    }
}

/**
 * Get the current instance of the browser. If there isn't one, create it
 * @param {integer} remoteBrowserID Path to executable
 * @param {integer} userId User ID
 * @returns {Promise<Browser>} The browser
 */
async function getRemoteBrowser(remoteBrowserID, userId) {
    let remoteBrowser = await RemoteBrowser.get(remoteBrowserID, userId);
    log.debug("MONITOR", `Using remote browser: ${remoteBrowser.name} (${remoteBrowser.id})`);
    browser = await chromium.connect(remoteBrowser.url);
    return browser;
}

/**
 * Prepare the chrome executable path
 * @param {string} executablePath Path to chrome executable
 * @returns {Promise<string>} Executable path
 */
async function prepareChromeExecutable(executablePath) {
    // Special code for using the playwright_chromium
    if (typeof executablePath === "string" && executablePath.toLocaleLowerCase() === "#playwright_chromium") {
        // Set to undefined = use playwright_chromium
        executablePath = undefined;
    } else if (!executablePath) {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            executablePath = "/usr/bin/chromium";

            // Install chromium in container via apt install
            if ( !commandExistsSync(executablePath)) {
                await new Promise((resolve, reject) => {
                    log.info("Chromium", "Installing Chromium...");
                    let child = childProcess.exec("apt update && apt --yes --no-install-recommends install chromium fonts-indic fonts-noto fonts-noto-cjk");

                    // On exit
                    child.on("exit", (code) => {
                        log.info("Chromium", "apt install chromium exited with code " + code);

                        if (code === 0) {
                            log.info("Chromium", "Installed Chromium");
                            let version = childProcess.execSync(executablePath + " --version").toString("utf8");
                            log.info("Chromium", "Chromium version: " + version);
                            resolve();
                        } else if (code === 100) {
                            reject(new Error("Installing Chromium, please wait..."));
                        } else {
                            reject(new Error("apt install chromium failed with code " + code));
                        }
                    });
                });
            }

        } else {
            executablePath = findChrome(allowedList);
        }
    } else {
        // User specified a path
        // Check if the executablePath is in the list of allowed
        if (!await isAllowedChromeExecutable(executablePath)) {
            throw new Error("This Chromium executable path is not allowed by default. If you are sure this is safe, please add an environment variable UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC=1 to allow it.");
        }
    }
    return executablePath;
}

/**
 * Find the chrome executable
 * @param {any[]} executables Executables to search through
 * @returns {any} Executable
 * @throws Could not find executable
 */
function findChrome(executables) {
    // Use the last working executable, so we don't have to search for it again
    if (lastAutoDetectChromeExecutable) {
        if (commandExistsSync(lastAutoDetectChromeExecutable)) {
            return lastAutoDetectChromeExecutable;
        }
    }

    for (let executable of executables) {
        if (commandExistsSync(executable)) {
            lastAutoDetectChromeExecutable = executable;
            return executable;
        }
    }
    throw new Error("Chromium not found, please specify Chromium executable path in the settings page.");
}

/**
 * Reset chrome
 * @returns {Promise<void>}
 */
async function resetChrome() {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

/**
 * Test if the chrome executable is valid and return the version
 * @param {string} executablePath Path to executable
 * @returns {Promise<string>} Chrome version
 */
async function testChrome(executablePath) {
    try {
        executablePath = await prepareChromeExecutable(executablePath);

        log.info("Chromium", "Testing Chromium executable: " + executablePath);

        const browser = await chromium.launch({
            executablePath,
        });
        const version = browser.version();
        await browser.close();
        return version;
    } catch (e) {
        throw new Error(e.message);
    }
}
// test remote browser
/**
 * @param {string} remoteBrowserURL Remote Browser URL
 * @returns {Promise<boolean>} Returns if connection worked
 */
async function testRemoteBrowser(remoteBrowserURL) {
    try {
        const browser = await chromium.connect(remoteBrowserURL);
        browser.version();
        await browser.close();
        return true;
    } catch (e) {
        throw new Error(e.message);
    }
}
class RealBrowserMonitorType extends MonitorType {

    name = "real-browser";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const browser = monitor.remote_browser ? await getRemoteBrowser(monitor.remote_browser, monitor.user_id) : await getBrowser();

        // Prevent Local File Inclusion
        // Accept only http:// and https://
        // https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h
        let url = new URL(monitor.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Invalid url protocol, only http and https are allowed.");
        }

        let filename = jwt.sign(monitor.id, server.jwtSecret);
        let screenshotPath = path.join(Database.screenshotDir, filename + ".png");
        let videoPath = null;

        // FORCE VIDEO RECORDING FOR TESTING - ALWAYS RECORD
        const recordVideo = true; // Force recording regardless of setting
        log.debug("monitor", `[${monitor.name}] Video recording FORCED enabled: ${recordVideo}`);

        // Configure context with video recording - ALWAYS ENABLED
        videoPath = path.join(Database.videoDir, filename + ".webm");
        log.info("monitor", `[${monitor.name}] Video directory: ${Database.videoDir}`);
        log.info("monitor", `[${monitor.name}] Video path will be: ${videoPath}`);

        const contextOptions = {
            recordVideo: {
                dir: Database.videoDir,
                size: {
                    width: 1280,
                    height: 720
                }
            }
        };
        
        log.info("monitor", `[${monitor.name}] Creating browser context with options:`, JSON.stringify(contextOptions, null, 2));
        const context = await browser.newContext(contextOptions);
        log.info("monitor", `[${monitor.name}] Browser context created successfully`);

        const page = await context.newPage();
        log.info("monitor", `[${monitor.name}] New page created successfully`);

        // FORCE URL TO EXAMPLE.COM FOR TESTING
        const testUrl = "https://example.com";
        log.debug("monitor", `[${monitor.name}] FORCING URL to ${testUrl} for video testing`);

        const res = await page.goto(testUrl, {
            waitUntil: "networkidle",
            timeout: 30000, // 30 seconds timeout
        });

        // FORCE 5 SECOND DELAY FOR VIDEO RECORDING
        log.debug("monitor", `[${monitor.name}] Waiting 5 seconds for video recording...`);
        await page.waitForTimeout(5000);

        // Take screenshot
        await page.screenshot({
            path: screenshotPath,
        });

        // FORCE SAVE VIDEO - ALWAYS SAVE
        if (videoPath) {
            try {
                log.info("monitor", `[${monitor.name}] Starting video save process...`);
                const video = page.video();
                log.info("monitor", `[${monitor.name}] Video object retrieved:`, video ? "exists" : "null");
                
                if (video) {
                    log.info("monitor", `[${monitor.name}] Attempting to save video to: ${videoPath}`);
                    
                    // Close the page first to ensure video recording is finalized
                    await page.close();
                    log.info("monitor", `[${monitor.name}] Page closed, saving video...`);
                    
                    await video.saveAs(videoPath);
                    log.info("monitor", `[${monitor.name}] Video save command completed`);
                    
                    // Small delay to ensure file is written
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Check if file was actually created and has content
                    const fs = require('fs');
                    if (fs.existsSync(videoPath)) {
                        const stats = fs.statSync(videoPath);
                        log.info("monitor", `[${monitor.name}] Video file created successfully - Size: ${stats.size} bytes`);
                    } else {
                        log.error("monitor", `[${monitor.name}] Video file was not created at ${videoPath}`);
                    }
                } else {
                    log.warn("monitor", `[${monitor.name}] No video object available to save - check if recordVideo context option is working`);
                }
            } catch (error) {
                log.error("monitor", `[${monitor.name}] FAILED to save video: ${error.message}`);
                log.error("monitor", `[${monitor.name}] Error stack:`, error.stack);
            }
        } else {
            log.error("monitor", `[${monitor.name}] No video path defined!`);
        }

        // Context will be closed after video save, or close it here if no video
        if (!videoPath) {
            await context.close();
        } else {
            // Context will be closed after video processing
            await context.close();
        }

        if (res.status() >= 200 && res.status() < 400) {
            heartbeat.status = UP;
            heartbeat.msg = res.status();

            const timing = res.request().timing();
            heartbeat.ping = timing.responseEnd;
        } else {
            throw new Error(res.status() + "");
        }
    }

    /**
     * Execute test commands for visual testing
     * @param {Page} page Playwright page instance
     * @param {object} monitor Monitor configuration
     * @returns {Promise<void>}
     */
    async executeTestCommands(page, monitor) {
        // Using hardcoded example commands for testing
        // User's JSON input in monitor.testCommands is ignored until this is proven to work
        const exampleCommands = [
            { action: "wait",
                duration: 1000 },
            { action: "click",
                selector: "h1" },
            { action: "wait",
                duration: 500 },
            { action: "scroll",
                direction: "down",
                pixels: 300 },
            { action: "wait",
                duration: 1000 },
            { action: "type",
                selector: "body",
                text: " - Visual Test" },
            { action: "wait",
                duration: 1000 }
        ];

        log.debug("monitor", `[${monitor.name}] Executing ${exampleCommands.length} test commands`);

        for (const command of exampleCommands) {
            try {
                await this.executeCommand(page, command);
            } catch (error) {
                log.warn("monitor", `[${monitor.name}] Test command failed: ${command.action} - ${error.message}`);
                // Continue with other commands even if one fails
            }
        }
    }

    /**
     * Execute a single test command
     * @param {Page} page Playwright page instance
     * @param {object} command Command to execute
     * @returns {Promise<void>}
     */
    async executeCommand(page, command) {
        switch (command.action) {
            case "wait":
                await page.waitForTimeout(command.duration || 1000);
                break;

            case "click":
                if (command.selector) {
                    await page.click(command.selector);
                }
                break;

            case "type":
                if (command.selector && command.text) {
                    await page.type(command.selector, command.text);
                }
                break;

            case "scroll":
                if (command.direction === "down") {
                    await page.mouse.wheel(0, command.pixels || 300);
                } else if (command.direction === "up") {
                    await page.mouse.wheel(0, -(command.pixels || 300));
                }
                break;

            case "screenshot":
                // Take additional screenshot during test
                const timestamp = Date.now();
                const filename = jwt.sign(monitor.id + "-" + timestamp, server.jwtSecret) + ".png";
                await page.screenshot({
                    path: path.join(Database.screenshotDir, filename),
                });
                break;

            default:
                log.warn("monitor", `Unknown test command: ${command.action}`);
        }
    }
}

module.exports = {
    RealBrowserMonitorType,
    testChrome,
    resetChrome,
    testRemoteBrowser,
};
