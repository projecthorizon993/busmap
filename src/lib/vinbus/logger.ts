/**
 * BusMap Logger - captures console output for debugging on mobile devices.
 * Logs are stored in localStorage and can be exported as a downloadable file.
 */

/**
 * BusMap Logger - captures console output for debugging on mobile devices.
 * Logs are stored in localStorage and can be exported as a downloadable file.
 */

const MAX_LOGS = 500;
const LOGS_STORAGE_KEY = 'busmap_logs';

interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
}

declare global {
  interface Window {
    __originalConsole?: Console;
    __loggerInitialized?: boolean;
  }
}

const getStoredLogs = (): LogEntry[] => {
  try {
    const stored = localStorage.getItem(LOGS_STORAGE_KEY);
    if (stored) return JSON.parse(stored) as LogEntry[];
  } catch { /* ignore */ }
  return [];
};

const storeLogs = (logs: LogEntry[]) => {
  try {
    localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs.slice(-MAX_LOGS)));
  } catch { /* ignore */ }
};

const formatArgs = (args: unknown[]): string[] => {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  });
};

const addLog = (level: LogEntry['level'], args: unknown[]) => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    args: formatArgs(args),
  };

  const logs = getStoredLogs();
  logs.push(entry);
  storeLogs(logs);

  // Also forward to original console
  const originalConsole = window.__originalConsole || console;
  originalConsole[level](...args);
};

export const initLogger = () => {
  if (window.__loggerInitialized) return;
  window.__loggerInitialized = true;

  const originalConsole = { ...console };

  window.__originalConsole = originalConsole;

  console.log = (...args: unknown[]) => {
    addLog('log', args);
    originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    addLog('warn', args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    addLog('error', args);
    originalConsole.error(...args);
  };
  console.info = (...args: unknown[]) => {
    addLog('info', args);
    originalConsole.info(...args);
  };

  // Capture uncaught errors
  window.addEventListener('error', (event) => {
    addLog('error', [event.message || 'Unknown error', event.filename || '', event.lineno || '', event.colno || '']);
  });

  window.addEventListener('unhandledrejection', (event) => {
    addLog('error', ['Unhandled promise rejection:', event.reason || 'Unknown reason']);
  });

  console.log('[BusMap] Logger initialized');
};

export const getLogs = (): LogEntry[] => {
  return getStoredLogs();
};

export const exportLogs = (): string => {
  const logs = getStoredLogs();
  if (logs.length === 0) return 'No logs captured.\n';

  let output = 'BusMap Log Export\n';
  output += '==================\n';
  output += 'Generated: ' + new Date().toISOString() + '\n';
  output += 'Total entries: ' + logs.length + '\n';
  output += '==================\n\n';

  for (const entry of logs) {
    output += '[' + entry.timestamp + '] [' + entry.level.toUpperCase() + '] ';
    output += entry.args.join(' ');
    output += '\n';
  }

  return output;
};

export const downloadLogs = (): void => {
  const output = exportLogs();
  const blob = new Blob([output], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'busmap-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const clearLogs = (): void => {
  try {
    localStorage.removeItem(LOGS_STORAGE_KEY);
  } catch { /* ignore */ }
};
