# StatusCobra V2 Scaling Guide

## Overview

This guide explains how to scale StatusCobra V2 to handle thousands of monitoring connections using Redis-based job queues while preserving all existing functionality.

## Current vs Scaled Architecture

### Before (Traditional Mode)
- Each monitor runs in-memory with `setTimeout`
- Single process handles all monitoring tasks
- Limited to ~500-1000 monitors per instance
- Sequential startup with random delays

### After (Redis Queue Mode)
- Monitors executed via Redis job queue (BullMQ)
- Horizontal scaling with multiple workers
- Handle thousands of monitors efficiently  
- Preserves ALL existing monitor logic and features
- Graceful fallback to traditional mode

## Quick Start

### 1. Environment Setup

Copy the environment template:
```bash
cp docker/env.queue.example .env
```

Edit `.env` to enable queue mode:
```bash
ENABLE_QUEUE_MODE=true
REDIS_HOST=localhost
REDIS_PORT=6379
QUEUE_CONCURRENCY=50
```

### 2. Install Dependencies

```bash
npm install bullmq@~5.4.2
```

### 3. Start with Redis Queue

Using Docker Compose:
```bash
# Basic scaling setup
docker-compose -f docker/docker-compose-redis-queue.yml up -d

# With Redis monitoring
docker-compose -f docker/docker-compose-redis-queue.yml --profile monitoring up -d

# With additional workers for max scaling
docker-compose -f docker/docker-compose-redis-queue.yml --profile workers up -d
```

## Configuration Options

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_QUEUE_MODE` | `false` | Enable Redis queue system |
| `REDIS_HOST` | `localhost` | Redis server hostname |
| `REDIS_PORT` | `6379` | Redis server port |
| `REDIS_PASSWORD` | _(none)_ | Redis authentication password |
| `REDIS_DB` | `0` | Redis database number |
| `QUEUE_CONCURRENCY` | `50` | Concurrent monitors per worker |
| `QUEUE_MAX_JOBS` | `1000` | Rate limit (jobs per minute) |

### Scaling Recommendations

#### Small Scale (100-500 monitors)
```bash
ENABLE_QUEUE_MODE=false  # Use traditional mode
```

#### Medium Scale (500-2000 monitors)
```bash
ENABLE_QUEUE_MODE=true
QUEUE_CONCURRENCY=50
# Single instance with Redis
```

#### Large Scale (2000-10000 monitors)
```bash
ENABLE_QUEUE_MODE=true
QUEUE_CONCURRENCY=30
# Multiple worker instances
```

#### Enterprise Scale (10000+ monitors)
```bash
ENABLE_QUEUE_MODE=true
QUEUE_CONCURRENCY=20
# Redis cluster + multiple workers
```

## Architecture Details

### How It Works

1. **Queue Integration Layer**: Seamlessly switches between traditional and queue modes
2. **Monitor Execution**: Preserves existing `Monitor.performCheck()` logic
3. **Scheduling**: Replaces `setTimeout` with Redis delayed jobs
4. **Horizontal Scaling**: Multiple workers can process the same queue

### Preserved Functionality

✅ **All monitor types** (HTTP, Ping, Port, Push, etc.)  
✅ **Heartbeat storage and notifications**  
✅ **Socket.io real-time updates**  
✅ **Uptime calculations**  
✅ **Retry logic and intervals**  
✅ **Maintenance windows**  
✅ **Status pages**  
✅ **All existing APIs**  

### Key Components

#### 1. Queue Manager (`server/queue/queue-manager.js`)
- Manages Redis queues and workers
- Processes monitor checks
- Handles job scheduling and retries

#### 2. Queue Integration (`server/queue/queue-integration.js`)
- Provides seamless switching between modes
- Preserves backward compatibility
- Graceful fallback mechanisms

#### 3. Enhanced Monitor Model
- Added `performCheck()` method for queue compatibility
- Preserves original `start()` method
- Uses existing monitor type system

## Monitoring & Debugging

### Queue Statistics

Access queue stats via the application:
```javascript
// In your application code
const { queueIntegration } = require('./server/queue/queue-integration');
const stats = await queueIntegration.getStats();
console.log(stats);
```

### Redis Commander (Optional)

Access Redis Commander at `http://localhost:8081` to monitor:
- Active jobs
- Failed jobs  
- Queue performance
- Memory usage

### Health Checks

```bash
# Check queue health
curl http://localhost:3001/api/queue/health

# Get queue statistics  
curl http://localhost:3001/api/queue/stats
```

## Performance Tuning

### Redis Configuration

For optimal performance, tune Redis settings:

```bash
# In redis.conf or via command line
maxmemory 1gb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
save 60 10000
```

### Queue Settings

Adjust based on your infrastructure:

```bash
# For CPU-bound monitors (HTTP checks)
QUEUE_CONCURRENCY=30

# For I/O-bound monitors (database checks)  
QUEUE_CONCURRENCY=100

# Rate limiting for external APIs
QUEUE_MAX_JOBS=500
```

### Hardware Recommendations

#### Medium Scale (2000 monitors)
- **CPU**: 4 cores
- **RAM**: 8GB  
- **Redis**: 2GB RAM
- **Network**: 100 Mbps

#### Large Scale (10000 monitors)
- **CPU**: 8 cores
- **RAM**: 16GB
- **Redis**: 4GB RAM  
- **Network**: 1 Gbps

## Migration Guide

### From Traditional to Queue Mode

1. **Backup your data** (always!)
2. **Install Redis** and BullMQ dependencies
3. **Set environment variables** for queue mode
4. **Restart application** - monitors will migrate automatically
5. **Monitor performance** and adjust concurrency

### Rollback Procedure

If issues occur, you can instantly rollback:

1. Set `ENABLE_QUEUE_MODE=false`
2. Restart application
3. Application returns to traditional setTimeout mode

**No data loss** - all monitor configurations and history preserved.

## Troubleshooting

### Common Issues

#### Redis Connection Failed
```bash
# Check Redis is running
docker ps | grep redis

# Check Redis connectivity
redis-cli -h localhost -p 6379 ping
```

#### High Memory Usage
```bash
# Check Redis memory
redis-cli info memory

# Clear completed jobs
redis-cli FLUSHDB
```

#### Slow Monitor Execution
```bash
# Reduce concurrency
QUEUE_CONCURRENCY=25

# Check for resource constraints
docker stats
```

### Logs and Debugging

Enable debug logging:
```bash
DEBUG=queue* node server/server.js
```

Monitor queue performance:
```bash
# Watch queue sizes
watch "redis-cli llen monitor-checks:waiting"
```

## Security Considerations

### Redis Security

1. **Use Redis password authentication**
2. **Bind Redis to localhost only** (unless clustering)
3. **Use Redis ACLs** for fine-grained access control
4. **Enable TLS** for Redis connections in production

### Environment Variables

Store sensitive data securely:
```bash
# Use Docker secrets or external secret management
REDIS_PASSWORD_FILE=/run/secrets/redis_password
```

## Support and Contributing

### Getting Help

1. Check the [troubleshooting section](#troubleshooting)
2. Review Redis logs: `docker logs uptime-kuma-redis`
3. Check application logs: `docker logs uptime-kuma-scaled`

### Contributing

This scaling implementation:
- ✅ Preserves all existing functionality
- ✅ Maintains backward compatibility  
- ✅ Follows existing code patterns
- ✅ Includes comprehensive testing

Submit issues and improvements via GitHub.

---

**Note**: This implementation ensures your existing StatusCobra V2 setup continues working exactly as before, with the option to scale when needed.
