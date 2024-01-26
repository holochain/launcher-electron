import { optimizer } from '@electron-toolkit/utils';
import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import * as childProcess from 'child_process';
import { Command, Option } from 'commander';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { app, ipcMain, protocol } from 'electron';
import { createIPCHandler } from 'electron-trpc/main';
import type { ZomeCallSigner, ZomeCallUnsignedNapi } from 'hc-launcher-rust-utils';
import path from 'path';
import z from 'zod';

import type {
  HolochainDataRoot,
  HolochainPartition,
  LoadingProgressUpdate,
  Screen,
  WindowInfoRecord,
} from '../types';
import {
  CHECK_INITIALIZED_KEYSTORE_ERROR,
  ExtendedAppInfoSchema,
  FILE_UNDEFINED_ERROR,
  InstallHappInputSchema,
  InstallKandoSchema,
  LOADING_PROGRESS_UPDATE,
  mainScreen,
  NO_RUNNING_HOLOCHAIN_MANAGER_ERROR,
  settingsScreen,
  WRONG_INSTALLED_APP_STRUCTURE,
} from '../types';
import { validateArgs } from './cli';
import { LauncherFileSystem } from './filesystem';
import { HolochainManager } from './holochainManager';
// import { AdminWebsocket } from '@holochain/client';
import { initializeLairKeystore, launchLairKeystore } from './lairKeystore';
import { LauncherEmitter } from './launcherEmitter';
import { setupLogs } from './logs';
import { DEFAULT_APPS_DIRECTORY } from './paths';
import { isHappAlreadyOpened, throwTRPCErrorError, validateWithZod } from './utils';
import { createHappWindow, setupAppWindows } from './windows';

const t = initTRPC.create({ isServer: true });

const rustUtils = require('hc-launcher-rust-utils');

const cli = new Command();

cli
  .name('Holochain Launcher')
  .description('Running Holochain Launcher via the command line.')
  .version(app.getVersion())
  .option(
    '-p, --profile <string>',
    'Runs the Launcher with a custom profile with its own dedicated data store.',
  )
  .option(
    '--holochain-path <string>',
    'Runs the Holochain Launcher with the holochain binary at the provided path. This creates an independent conductor from when running the Launcher with the built-in binary.',
  )
  .option(
    '--lair-binary-path <string>',
    "Runs the Holochain Launcher with the lair binary at the provided path. Make sure to use a lair binary that's compatible with the existing keystore.",
  )
  .addOption(
    new Option(
      '--admin-port <number>',
      'If specified, the Launcher expectes an external holochain binary to run at this port. Requires the --lair-url and --apps-data-dir options to be specified as well.',
    ).argParser(parseInt),
  )
  .option(
    '--lair-url <string>',
    'URL of the lair keystore server associated to the externally running holochain binary.',
  )
  .option(
    '--apps-data-dir <string>',
    'Path where the Launcher can store app UI assets and other metadata when running an external holochain binary.',
  )
  .option(
    '-b, --bootstrap-url <url>',
    'URL of the bootstrap server to use. Is ignored if an external holochain binary is being used.',
  )
  .option(
    '-s, --signaling-url <url>',
    'URL of the signaling server to use. Is ignored if an external holochain binary is being used.',
  );

cli.parse();

console.log('GOT CLI ARGS: ', cli.opts());

const [PROFILE, HOLOCHAIN_VERSION, LAIR_BINARY_PATH, BOOTSTRAP_URL, SIGNALING_URL] = validateArgs(
  cli.opts(),
);

console.log('VALIDATED CLI ARGS: ', PROFILE, HOLOCHAIN_VERSION, BOOTSTRAP_URL, SIGNALING_URL);

const appName = app.getName();

if (process.env.NODE_ENV === 'development') {
  console.log('APP IS RUN IN DEVELOPMENT MODE');
  app.setName(appName + '-dev');
}

console.log('APP PATH: ', app.getAppPath());
console.log('RUNNING ON PLATFORM: ', process.platform);

const isFirstInstance = app.requestSingleInstanceLock();

if (!isFirstInstance) {
  app.quit();
}

app.on('second-instance', () => {
  LAUNCHER_WINDOWS[mainScreen].show();
});

app.on('activate', () => {
  LAUNCHER_WINDOWS[mainScreen].show();
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'webhapp',
    privileges: { standard: true },
  },
]);

const LAUNCHER_FILE_SYSTEM = LauncherFileSystem.connect(app, PROFILE);
const LAUNCHER_EMITTER = new LauncherEmitter();

setupLogs(LAUNCHER_EMITTER, LAUNCHER_FILE_SYSTEM);

let DEFAULT_ZOME_CALL_SIGNER: ZomeCallSigner | undefined;
// Zome call signers for external binaries (admin ports used as keys)
const CUSTOM_ZOME_CALL_SIGNERS: Record<number, ZomeCallSigner> = {};

// For now there is only one holochain data root at a time for the sake of simplicity.
let HOLOCHAIN_DATA_ROOT: HolochainDataRoot | undefined;
const HOLOCHAIN_MANAGERS: Record<string, HolochainManager> = {}; // holochain managers sorted by HolochainDataRoot.name
let LAIR_HANDLE: childProcess.ChildProcessWithoutNullStreams | undefined;
let LAUNCHER_WINDOWS: Record<Screen, BrowserWindow>;
const WINDOW_INFO_MAP: WindowInfoRecord = {}; // WindowInfo by webContents.id - used to verify origin of zome call requests

const handleSignZomeCall = (e: IpcMainInvokeEvent, zomeCall: ZomeCallUnsignedNapi) => {
  const windowInfo = WINDOW_INFO_MAP[e.sender.id];
  if (zomeCall.provenance.toString() !== Array.from(windowInfo.agentPubKey).toString())
    return Promise.reject('Agent public key unauthorized.');
  if (windowInfo.adminPort) {
    // In case of externally running binaries we need to use a custom zome call signer
    const zomeCallSigner = CUSTOM_ZOME_CALL_SIGNERS[windowInfo.adminPort];
    return zomeCallSigner.signZomeCall(zomeCall);
  }
  if (!DEFAULT_ZOME_CALL_SIGNER) throw Error('Lair signer is not ready');
  return DEFAULT_ZOME_CALL_SIGNER.signZomeCall(zomeCall);
};

// // Handle creating/removing shortcuts on Windows when installing/uninstalling.
// if (require('electron-squirrel-startup')) {
//   app.quit();
// }

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
    // Default open or close DevTools by F12 in development and ignore CommandOrControl + R in production.
  });

  console.log('BEING RUN IN __dirnmane: ', __dirname);

  LAUNCHER_WINDOWS = setupAppWindows();

  createIPCHandler({ router, windows: Object.values(LAUNCHER_WINDOWS) });

  ipcMain.handle('sign-zome-call', handleSignZomeCall);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
});

// app.on('will-quit', (e: Event) => {
//   // let the launcher run in the background (systray)
//   // e.preventDefault();
// })

app.on('quit', () => {
  if (LAIR_HANDLE) {
    LAIR_HANDLE.kill();
    LAIR_HANDLE = undefined;
  }
  Object.values(HOLOCHAIN_MANAGERS).forEach((manager) => {
    if (manager.processHandle) {
      manager.processHandle.kill();
    }
  });
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

async function handleSetupAndLaunch(password: string) {
  if (!LAUNCHER_WINDOWS) throw new Error('Main window needs to exist before launching.');

  if (HOLOCHAIN_VERSION.type !== 'running-external') {
    const lairHandleTemp = childProcess.spawnSync(LAIR_BINARY_PATH, ['--version']);
    if (!lairHandleTemp.stdout) {
      console.error(`Failed to run lair-keystore binary:\n${lairHandleTemp}`);
    }
    console.log(`Got lair version ${lairHandleTemp.stdout.toString()}`);
    if (!LAUNCHER_FILE_SYSTEM.keystoreInitialized()) {
      LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'initializingLairKeystore');
      await initializeLairKeystore(
        LAIR_BINARY_PATH,
        LAUNCHER_FILE_SYSTEM.keystoreDir,
        LAUNCHER_EMITTER,
        password,
      );
    }
  }

  await handleLaunch(password);
}

async function handleLaunch(password: string) {
  LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'startingLairKeystore');
  let lairUrl: string;

  if (HOLOCHAIN_VERSION.type === 'running-external') {
    lairUrl = HOLOCHAIN_VERSION.lairUrl;
    const externalZomeCallSigner = await rustUtils.ZomeCallSigner.connect(lairUrl, password);
    CUSTOM_ZOME_CALL_SIGNERS[HOLOCHAIN_VERSION.adminPort] = externalZomeCallSigner;
  } else {
    const [lairHandle, lairUrl2] = await launchLairKeystore(
      LAIR_BINARY_PATH,
      LAUNCHER_FILE_SYSTEM.keystoreDir,
      LAUNCHER_EMITTER,
      password,
    );

    lairUrl = lairUrl2;

    LAIR_HANDLE = lairHandle;

    DEFAULT_ZOME_CALL_SIGNER = await rustUtils.ZomeCallSigner.connect(lairUrl, password);
  }

  LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'startingHolochain');

  if (!LAUNCHER_WINDOWS) throw new Error('Main window needs to exist before launching.');

  const nonDefaultPartition: HolochainPartition =
    HOLOCHAIN_VERSION.type === 'running-external'
      ? { type: 'external', name: 'unknown', path: HOLOCHAIN_VERSION.appsDataDir }
      : HOLOCHAIN_VERSION.type === 'custom-path'
        ? { type: 'custom', name: 'unknown' }
        : { type: 'default' };

  console.log('HOLOCHAIN_VERSION: ', HOLOCHAIN_VERSION);

  const [holochainManager, holochainDataRoot] = await HolochainManager.launch(
    LAUNCHER_EMITTER,
    LAUNCHER_FILE_SYSTEM,
    password,
    HOLOCHAIN_VERSION,
    lairUrl,
    BOOTSTRAP_URL,
    SIGNALING_URL,
    nonDefaultPartition,
  );
  HOLOCHAIN_DATA_ROOT = holochainDataRoot;
  HOLOCHAIN_MANAGERS[holochainDataRoot.name] = holochainManager;
  LAUNCHER_WINDOWS[mainScreen].setSize(600, 200, true);
  return;
}

const handlePasswordInput = (handler: (password: string) => Promise<void>) =>
  t.procedure.input(z.object({ password: z.string() })).mutation((req) => {
    const {
      input: { password },
    } = req;
    return handler(password);
  });

const getHolochainManager = (dataRootName: string) => {
  const holochainManager = HOLOCHAIN_MANAGERS[dataRootName];
  if (!holochainManager) {
    return throwTRPCErrorError({
      message: NO_RUNNING_HOLOCHAIN_MANAGER_ERROR,
      cause: `No running Holochain Manager found for the specified partition: '${dataRootName}'`,
    });
  }
  return holochainManager;
};

const router = t.router({
  openSettings: t.procedure.mutation(() => {
    LAUNCHER_WINDOWS[mainScreen].hide();
    LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'settings');
    LAUNCHER_WINDOWS[settingsScreen].show();
  }),
  hideApp: t.procedure.mutation(() => {
    LAUNCHER_WINDOWS[mainScreen].hide();
  }),
  openApp: t.procedure.input(ExtendedAppInfoSchema).mutation(async (opts) => {
    const { appInfo, holochainDataRoot } = opts.input;
    const holochainManager = getHolochainManager(holochainDataRoot.name);

    if (isHappAlreadyOpened({ installed_app_id: appInfo.installed_app_id, WINDOW_INFO_MAP })) {
      return;
    }

    const happWindow = createHappWindow(opts.input, LAUNCHER_FILE_SYSTEM, holochainManager.appPort);
    WINDOW_INFO_MAP[happWindow.webContents.id] = {
      installedAppId: appInfo.installed_app_id,
      agentPubKey: appInfo.agent_pub_key,
      adminPort:
        HOLOCHAIN_VERSION.type === 'running-external' ? HOLOCHAIN_VERSION.adminPort : undefined,
    };
    happWindow.on('close', () => {
      delete WINDOW_INFO_MAP[happWindow.webContents.id];
    });
  }),
  uninstallApp: t.procedure.input(ExtendedAppInfoSchema).mutation(async (opts) => {
    const { appInfo, holochainDataRoot } = opts.input;
    const holochainManager = getHolochainManager(holochainDataRoot.name);
    await holochainManager.uninstallApp(appInfo.installed_app_id);
  }),
  installHapp: t.procedure.input(InstallHappInputSchema).mutation(async (opts) => {
    const { filePath, appId, networkSeed } = opts.input;

    const holochainManager = getHolochainManager(HOLOCHAIN_DATA_ROOT!.name);
    if (!filePath) {
      throwTRPCErrorError({
        message: FILE_UNDEFINED_ERROR,
      });
    }
    await holochainManager.installWebHapp(filePath, appId, networkSeed);
  }),
  installKando: t.procedure.input(InstallKandoSchema).mutation(async (opts) => {
    const { appId, networkSeed } = opts.input;

    const filePath = path.join(DEFAULT_APPS_DIRECTORY, 'kando.webhapp');

    const holochainManager = getHolochainManager(HOLOCHAIN_DATA_ROOT!.name);
    await holochainManager.installWebHapp(filePath, appId, networkSeed);
  }),
  lairSetupRequired: t.procedure.query(() => {
    const isInitialized =
      LAUNCHER_FILE_SYSTEM.keystoreInitialized() || HOLOCHAIN_VERSION.type === 'running-external';
    const isInitializedValidated = validateWithZod({
      schema: z.boolean(),
      data: isInitialized,
      errorType: CHECK_INITIALIZED_KEYSTORE_ERROR,
    });
    return !isInitializedValidated;
  }),
  getInstalledApps: t.procedure.query(() => {
    const installedApps = Object.values(HOLOCHAIN_MANAGERS).flatMap((manager) =>
      manager.installedApps.map((app) => ({
        appInfo: app,
        version: manager.version,
        holochainDataRoot: manager.holochainDataRoot,
      })),
    );

    const installedAppsValidated = validateWithZod({
      schema: z.array(ExtendedAppInfoSchema),
      data: installedApps,
      errorType: WRONG_INSTALLED_APP_STRUCTURE,
    });
    return installedAppsValidated;
  }),
  handleSetupAndLaunch: handlePasswordInput(handleSetupAndLaunch),
  launch: handlePasswordInput(handleLaunch),
  onSetupProgressUpdate: t.procedure.subscription(() => {
    return observable<LoadingProgressUpdate>((emit) => {
      function onProgressUpdate(text: LoadingProgressUpdate) {
        emit.next(text);
      }

      LAUNCHER_EMITTER.on(LOADING_PROGRESS_UPDATE, onProgressUpdate);

      return () => {
        LAUNCHER_EMITTER.off(LOADING_PROGRESS_UPDATE, onProgressUpdate);
      };
    });
  }),
});

export type AppRouter = typeof router;
