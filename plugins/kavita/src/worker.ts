import { startPluginWorkerServer } from '@readest/plugin-sdk';
import { kavitaPlugin } from './plugin';
startPluginWorkerServer(self, kavitaPlugin);
