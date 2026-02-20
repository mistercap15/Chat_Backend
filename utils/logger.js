const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = levels[LOG_LEVEL] ?? levels.info;

const formatMessage = (level, message, meta) => {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    return `${base} ${JSON.stringify(meta)}`;
  }
  return base;
};

const logger = {
  error: (message, meta = {}) => {
    if (currentLevel >= levels.error) {
      console.error(formatMessage('error', message, meta));
    }
  },
  warn: (message, meta = {}) => {
    if (currentLevel >= levels.warn) {
      console.warn(formatMessage('warn', message, meta));
    }
  },
  info: (message, meta = {}) => {
    if (currentLevel >= levels.info) {
      console.log(formatMessage('info', message, meta));
    }
  },
  debug: (message, meta = {}) => {
    if (currentLevel >= levels.debug) {
      console.log(formatMessage('debug', message, meta));
    }
  },
};

module.exports = logger;
