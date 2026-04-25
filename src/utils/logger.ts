import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, jobId, retailer, ...meta }) => {
  const extras = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  const context = [jobId && `job=${jobId}`, retailer && `retailer=${retailer}`]
    .filter(Boolean)
    .join(' ');
  return `${timestamp} [${level.toUpperCase()}]${context ? ` [${context}]` : ''} ${message}${extras}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console: colorized for human readability
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss' }),
        logFormat
      ),
    }),
    // File: structured for log aggregation (Datadog / CloudWatch compatible)
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: combine(timestamp(), winston.format.json()),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: combine(timestamp(), winston.format.json()),
    }),
  ],
});

// Child logger factory — attach job context to all messages in a job lifecycle
export function createJobLogger(jobId: string, retailer: string) {
  return logger.child({ jobId, retailer });
}
