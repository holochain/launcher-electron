import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import * as childProcess from 'child_process';
import { Command, Option } from 'commander';
import {
  app,
  BrowserWindow,
  ipcMain,
  IpcMainInvokeEvent,
  Menu,
  nativeImage,
  protocol,
  Tray,
} from 'electron';
import { ZomeCallSigner, ZomeCallUnsignedNapi } from 'hc-launcher-rust-utils';
import path from 'path';
import z from 'zod';

import {
  CHECK_INITIALIZED_KEYSTORE_ERROR,
  ExtendedAppInfo,
  ExtendedAppInfoSchema,
  FILE_UNDEFINED_ERROR,
  HolochainDataRoot,
  HolochainPartition,
  InstallHappInputSchema,
  InstallKandoSchema,
  LOADING_PROGRESS_UPDATE,
  LoadingProgressUpdate,
  NO_RUNNING_HOLOCHAIN_MANAGER_ERROR,
  WindowInfo,
  WRONG_INSTALLED_APP_STRUCTURE,
} from '../types';
import { LAIR_BINARY } from './binaries';
import { validateArgs } from './cli';
import { LauncherFileSystem } from './filesystem';
import { HolochainManager } from './holochainManager';
// import { AdminWebsocket } from '@holochain/client';
import { initializeLairKeystore, launchLairKeystore } from './lairKeystore';
import { LauncherEmitter } from './launcherEmitter';
import { setupLogs } from './logs';
import { DEFAULT_APPS_DIRECTORY, ICONS_DIRECTORY } from './paths';
import { validateWithZod } from './trpcHelpers';
import { throwTRPCErrorError } from './utils';
import { createHappWindow, createOrShowMainWindow } from './windows';

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
    'URL of the bootstrap server to use. Must be provided if running in applet dev mode with the --dev-config argument.',
  )
  .option(
    '-s, --signaling-url <url>',
    'URL of the signaling server to use. Must be provided if running in applet dev mode with the --dev-config argument.',
  );

cli.parse();

console.log('GOT CLI ARGS: ', cli.opts());

const [PROFILE, HOLOCHAIN_VERSION, BOOTSTRAP_URL, SIGNALING_URL] = validateArgs(cli.opts());

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
  MAIN_WINDOW = createOrShowMainWindow(MAIN_WINDOW, router);
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
let MAIN_WINDOW: BrowserWindow | undefined | null;
const WINDOW_INFO_MAP: Record<number, WindowInfo> = {}; // WindowInfo by webContents.id - used to verify origin of zome call requests

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

let tray;
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  console.log('BEING RUN IN __dirnmane: ', __dirname);
  const icon = nativeImage.createFromPath(path.join(ICONS_DIRECTORY, '16x16.png'));
  tray = new Tray(icon);

  MAIN_WINDOW = createOrShowMainWindow(MAIN_WINDOW, router);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      type: 'normal',
      click() {
        MAIN_WINDOW = createOrShowMainWindow(MAIN_WINDOW, router);
      },
    },
    {
      label: 'Quit',
      type: 'normal',
      click() {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Holochain Launcher');
  tray.setContextMenu(contextMenu);

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

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createOrShowMainWindow(MAIN_WINDOW, router);
  }
});

// app.on('will-quit', (e: Event) => {
//   // let the launcher run in the background (systray)
//   // e.preventDefault();
// })

app.on('quit', () => {
  if (LAIR_HANDLE) {
    LAIR_HANDLE.kill();
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
  if (!MAIN_WINDOW) throw new Error('Main window needs to exist before launching.');

  if (HOLOCHAIN_VERSION.type !== 'running-external') {
    const lairHandleTemp = childProcess.spawnSync(LAIR_BINARY, ['--version']);
    if (!lairHandleTemp.stdout) {
      console.error(`Failed to run lair-keystore binary:\n${lairHandleTemp}`);
    }
    console.log(`Got lair version ${lairHandleTemp.stdout.toString()}`);
    if (!LAUNCHER_FILE_SYSTEM.keystoreInitialized()) {
      LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'initializingLairKeystore');
      await initializeLairKeystore(
        LAIR_BINARY,
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
      LAIR_BINARY,
      LAUNCHER_FILE_SYSTEM.keystoreDir,
      LAUNCHER_EMITTER,
      password,
    );

    lairUrl = lairUrl2;

    LAIR_HANDLE = lairHandle;

    DEFAULT_ZOME_CALL_SIGNER = await rustUtils.ZomeCallSigner.connect(lairUrl, password);
  }

  LAUNCHER_EMITTER.emit(LOADING_PROGRESS_UPDATE, 'startingHolochain');

  if (!MAIN_WINDOW) throw new Error('Main window needs to exist before launching.');

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
  openApp: t.procedure.input(ExtendedAppInfoSchema).mutation(async (opts) => {
    const { appInfo, holochainDataRoot } = opts.input;
    const holochainManager = getHolochainManager(holochainDataRoot.name);
    const happWindow = createHappWindow(
      opts.input as ExtendedAppInfo,
      LAUNCHER_FILE_SYSTEM,
      holochainManager.appPort,
    );
    WINDOW_INFO_MAP[happWindow.webContents.id] = {
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
