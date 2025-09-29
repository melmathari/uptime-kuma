# Debugging Monitor Issues in Redis Queue System

This guide helps you debug monitor execution issues when using the Redis queue system in Uptime Kuma.

## Prerequisites

- Docker containers running (uptime-kuma-dev, uptime-kuma-redis-dev)
- Queue mode enabled (`ENABLE_QUEUE_MODE=true`)
- Access to Redis CLI through Docker

## Quick Diagnosis Steps

### 1. Check if Queue Mode is Active

Look for these log messages in the application:
```
[QUEUE-INTEGRATION] INFO: Starting monitors via Redis queue
[QUEUE] INFO: Starting all active monitors via queue system
```

If you see this instead, queue mode is disabled:
```
[QUEUE-INTEGRATION] INFO: Starting monitors via traditional method
```

### 2. Verify Redis Connection

```bash
# Test Redis connectivity
docker exec uptime-kuma-redis-dev redis-cli ping
# Should return: PONG

# Check if Redis has queue data
docker exec uptime-kuma-redis-dev redis-cli keys "*"
# Should show keys like: bull:monitor-checks:*
```

### 3. Check Queue Status

```bash
# View all Redis keys related to monitors
docker exec uptime-kuma-redis-dev redis-cli keys "bull:monitor-checks:*"

# Check failed jobs
docker exec uptime-kuma-redis-dev redis-cli zrange "bull:monitor-checks:failed" 0 -1

# Check active jobs
docker exec uptime-kuma-redis-dev redis-cli zrange "bull:monitor-checks:active" 0 -1

# Check waiting jobs
docker exec uptime-kuma-redis-dev redis-cli zrange "bull:monitor-checks:waiting" 0 -1
```

### 4. Examine Failed Jobs

```bash
# Get job IDs from failed queue
JOB_ID=$(docker exec uptime-kuma-redis-dev redis-cli zrange "bull:monitor-checks:failed" 0 0)

# Get job data
docker exec uptime-kuma-redis-dev redis-cli hget "bull:monitor-checks:$JOB_ID" "data"

# Get failure reason
docker exec uptime-kuma-redis-dev redis-cli hget "bull:monitor-checks:$JOB_ID" "failedReason"

# Get stack trace (if available)
docker exec uptime-kuma-redis-dev redis-cli hget "bull:monitor-checks:$JOB_ID" "stacktrace"
```

### 5. Check Application Logs

```bash
# View recent application logs
docker logs uptime-kuma-dev --tail 50

# Follow logs in real-time
docker logs uptime-kuma-dev -f
```

Look for these patterns:
- `[QUEUE] DEBUG: Processing monitor check for ID: X`
- `[QUEUE] ERROR: Monitor X check failed:`
- `[QUEUE] ERROR: Monitor check failed: X`

## Common Issues and Solutions

### Issue 1: Import/Module Errors

**Symptoms:**
- Error: `Cannot read properties of undefined (reading 'prototype')`
- Monitor checks fail immediately

**Diagnosis:**
```bash
docker exec uptime-kuma-redis-dev redis-cli hget "bull:monitor-checks:FAILED_JOB_ID" "failedReason"
```

**Solution:**
Check import statements in `queue-manager.js`. Ensure:
```javascript
// Correct
const Monitor = require("../model/monitor");

// Incorrect
const { Monitor } = require("../model/monitor");
```

### Issue 2: Monitor Type Not Found

**Symptoms:**
- Error: `MonitorType not found for type: X`
- Specific monitor types failing

**Diagnosis:**
Check if monitor type is registered in `uptime-kuma-server.js`:
```javascript
UptimeKumaServer.monitorTypeList["your-type"] = new YourMonitorType();
```

### Issue 3: Database Connection Issues

**Symptoms:**
- Error: `Monitor X not found or inactive`
- Database-related errors

**Diagnosis:**
```bash
# Check database container
docker ps | grep mariadb

# Check database connectivity from app container
docker exec uptime-kuma-dev npm run test-db
```

### Issue 4: Redis Connection Problems

**Symptoms:**
- Queue jobs not being created
- Connection timeouts

**Diagnosis:**
```bash
# Check Redis container health
docker exec uptime-kuma-redis-dev redis-cli info server

# Check Redis memory usage
docker exec uptime-kuma-redis-dev redis-cli info memory

# Test connection from app container
docker exec uptime-kuma-dev node -e "
const Redis = require('ioredis');
const redis = new Redis({host: 'redis', port: 6379});
redis.ping().then(console.log).catch(console.error);
"
```

## Debugging Specific Monitor

### Step 1: Identify Monitor ID
From application logs or Redis job data, get the monitor ID that's failing.

### Step 2: Get Monitor Details
```bash
# Access the application container
docker exec -it uptime-kuma-dev node -e "
const { R } = require('redbean-node');
R.setup();
R.findOne('monitor', 'id = ?', [MONITOR_ID]).then(monitor => {
  console.log('Monitor Details:', JSON.stringify(monitor, null, 2));
  process.exit(0);
});
"
```

### Step 3: Test Monitor Manually
```bash
# Test a specific monitor outside the queue
docker exec -it uptime-kuma-dev node -e "
const Monitor = require('./server/model/monitor');
const { R } = require('redbean-node');
const { UptimeKumaServer } = require('./server/uptime-kuma-server');

R.setup();
R.findOne('monitor', 'id = ?', [MONITOR_ID]).then(async (monitor) => {
  const monitorInstance = Object.setPrototypeOf(monitor, Monitor.prototype);
  const server = UptimeKumaServer.getInstance();
  try {
    await monitorInstance.performCheck(server.io);
    console.log('Monitor check successful');
  } catch (error) {
    console.error('Monitor check failed:', error);
  }
  process.exit(0);
});
"
```

### Step 4: Check Monitor Configuration
- Verify monitor URL/settings are correct
- Check if monitor type is supported
- Validate any required fields

## Environment Variables

Key environment variables for debugging:

```bash
# Enable queue mode
ENABLE_QUEUE_MODE=true

# Redis connection
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0

# Queue settings
QUEUE_CONCURRENCY=30
QUEUE_MAX_JOBS=500

# Debug logging
NODE_ENV=development
```

## Useful Redis Commands

```bash
# Monitor Redis commands in real-time
docker exec uptime-kuma-redis-dev redis-cli monitor

# Get Redis info
docker exec uptime-kuma-redis-dev redis-cli info all

# Clear all queue data (use with caution)
docker exec uptime-kuma-redis-dev redis-cli flushdb

# Get queue statistics
docker exec uptime-kuma-redis-dev redis-cli eval "
local waiting = redis.call('zcard', 'bull:monitor-checks:waiting')
local active = redis.call('zcard', 'bull:monitor-checks:active')
local failed = redis.call('zcard', 'bull:monitor-checks:failed')
local completed = redis.call('zcard', 'bull:monitor-checks:completed')
return {waiting, active, failed, completed}
" 0
```

## Prevention Tips

1. **Always test changes locally** before deploying queue modifications
2. **Monitor Redis memory usage** to prevent OOM issues
3. **Set appropriate job retention limits** in queue configuration
4. **Use proper error handling** in monitor type implementations
5. **Validate environment variables** on container startup

## When to Use Traditional Mode

Fall back to traditional mode (`ENABLE_QUEUE_MODE=false`) if:
- Redis is consistently unavailable
- Queue system introduces more issues than benefits
- Debugging complex monitor type interactions
- Development/testing scenarios where simplicity is preferred

## Getting Help

If issues persist:
1. Check application logs with increased verbosity
2. Examine Redis logs: `docker logs uptime-kuma-redis-dev`
3. Test with a minimal monitor configuration
4. Compare working vs failing monitor configurations
5. Create isolated test cases for specific monitor types
