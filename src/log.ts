let verbose = false;

export const setVerbose = (on: boolean): void => {
  verbose = on;
};

const write = (level: string, message: string): void => {
  process.stderr.write(`[bruno-mcp] ${level}${message}\n`);
};

export const error = (message: string): void => write('error: ', message);

export const warn = (message: string): void => write('warn: ', message);

export const debug = (message: string): void => {
  if (verbose) write('', message);
};
