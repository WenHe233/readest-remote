import { startPluginWorkerServer } from '@readest/plugin-sdk';
import { komgaPlugin } from './plugin';
startPluginWorkerServer(self, komgaPlugin);
