import { app } from 'electron';
import * as path from 'path';

export const DEFAULT_HOLOCHAIN_VERSION = '0.2.5-rc.0';

const BINARIES_DIRECTORY = app.isPackaged
  ? path.join(app.getAppPath(), '../app.asar.unpacked/resources/bins')
  : path.join(app.getAppPath(), './resources/bins');

const HOLOCHAIN_BINARIES = {
  '0.2.5-rc.0': path.join(
    BINARIES_DIRECTORY,
    `holochain-v${DEFAULT_HOLOCHAIN_VERSION}${process.platform === 'win32' ? '.exe' : ''}`,
  ),
};

const LAIR_BINARY = path.join(
  BINARIES_DIRECTORY,
  `lair-keystore-v0.3.0${process.platform === 'win32' ? '.exe' : ''}`,
);

export { HOLOCHAIN_BINARIES, LAIR_BINARY };
