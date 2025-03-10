import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid';
import isAbsoluteUrl from 'is-absolute-url';
import { Log } from './util/log';
import { findAddonId, normalizePath } from './util/misc';
import { isExecutable } from './util/fs';
import { Minimatch } from 'minimatch';
import FirefoxProfile from 'firefox-profile';
import { isWindowsPlatform } from '../common/util';
import { LaunchConfiguration, AttachConfiguration, CommonConfiguration, ReloadConfiguration, DetailedReloadConfiguration } from '../common/configuration';

let log = Log.create('ParseConfiguration');

export interface NormalizedReloadConfiguration {
	watch: string[];
	ignore: string[];
	debounce: number;
}

export interface ParsedConfiguration {
	attach?: ParsedAttachConfiguration;
	launch?: ParsedLaunchConfiguration;
	addon?: ParsedAddonConfiguration;
	pathMappings: PathMappings;
	filesToSkip: RegExp[];
	reloadOnChange?: NormalizedReloadConfiguration,
	clearConsoleOnReload: boolean,
	sourceMaps: 'client' | 'server';
	showConsoleCallLocation: boolean;
	liftAccessorsFromPrototypes: number;
}

export interface ParsedAttachConfiguration {
	host: string;
	port: number;
	reloadTabs: boolean;
}

export interface FirefoxPreferences {
	[key: string]: boolean | number | string;
}

type PathMapping = { url: string | RegExp, path: string | null };
export type PathMappings = PathMapping[];

export interface ParsedLaunchConfiguration {
	firefoxExecutable: string;
	firefoxArgs: string[];
	profileDir: string;
	srcProfileDir?: string;
	preferences: FirefoxPreferences;
	tmpDirs: string[];
	port: number;
	timeout: number;
	detached: boolean;
}

export interface ParsedAddonConfiguration {
	path: string;
	id: string | undefined;
	popupAutohideButton: boolean;
}

/**
 * Reads the configuration that was provided by VS Code, checks that it's consistent,
 * adds default values and returns it in a form that is easier to work with
 */
export async function parseConfiguration(
	config: LaunchConfiguration | AttachConfiguration
): Promise<ParsedConfiguration> {

	let attach: ParsedAttachConfiguration | undefined = undefined;
	let launch: ParsedLaunchConfiguration | undefined = undefined;
	let addon: ParsedAddonConfiguration | undefined = undefined;
	let port = config.port || 6000;
	let timeout = 5;
	let pathMappings: PathMappings = [];

	if (config.request === 'launch') {

		let tmpDirs: string[] = [];

		if (config.reAttach) {
			attach = {
				host: 'localhost', port,
				reloadTabs: (config.reloadOnAttach !== false)
			};
		}

		let firefoxExecutable = await findFirefoxExecutable(config.firefoxExecutable);

		let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];
		if (config.firefoxArgs) {
			firefoxArgs.push(...config.firefoxArgs);
		}

		let { profileDir, srcProfileDir } = await parseProfileConfiguration(config, tmpDirs);

		firefoxArgs.push('-profile', profileDir);

		let preferences = createFirefoxPreferences(config.preferences);

		if (config.file) {
			if (!path.isAbsolute(config.file)) {
				throw 'The "file" property in the launch configuration has to be an absolute path';
			}

			let fileUrl = config.file;
			if (isWindowsPlatform()) {
				fileUrl = 'file:///' + fileUrl.replace(/\\/g, '/');
			} else {
				fileUrl = 'file://' + fileUrl;
			}
			firefoxArgs.push(fileUrl);

		} else if (config.url) {
			firefoxArgs.push(config.url);
		} else if (config.addonPath) {
			firefoxArgs.push('about:blank');
		} else {
			throw 'You need to set either "file" or "url" in the launch configuration';
		}

		if (typeof config.timeout === 'number') {
			timeout = config.timeout;
		}

		let detached = !!config.reAttach;

		launch = {
			firefoxExecutable, firefoxArgs, profileDir, srcProfileDir,
			preferences, tmpDirs, port, timeout, detached
		};

	} else { // config.request === 'attach'

		attach = {
			host: config.host || 'localhost', port,
			reloadTabs: !!config.reloadOnAttach
		};
	}

	if (config.pathMappings) {
		pathMappings.push(...config.pathMappings.map(harmonizeTrailingSlashes));
	}

	if (config.addonPath) {
		addon = await parseAddonConfiguration(config, pathMappings);
	}

	const webRoot = parseWebRootConfiguration(config, pathMappings);

	if (webRoot) {
		pathMappings.push({ url: 'webpack:///~/', path: webRoot + '/node_modules/' });
		pathMappings.push({ url: 'webpack:///./~/', path: webRoot + '/node_modules/' });
		pathMappings.push({ url: 'webpack:///./', path: webRoot + '/' });
		pathMappings.push({ url: 'webpack:///src/', path: webRoot + '/src/' });
	}
	pathMappings.push({ url: (isWindowsPlatform() ? 'webpack:///' : 'webpack://'), path: '' });

	pathMappings.push({ url: (isWindowsPlatform() ? 'file:///' : 'file://'), path: ''});

	let filesToSkip = parseSkipFilesConfiguration(config);

	let reloadOnChange = parseReloadConfiguration(config.reloadOnChange);

	const clearConsoleOnReload = !!config.clearConsoleOnReload;

	let sourceMaps = config.sourceMaps || 'client';
	let showConsoleCallLocation = config.showConsoleCallLocation || false;
	let liftAccessorsFromPrototypes = config.liftAccessorsFromPrototypes || 0;

	return {
		attach, launch, addon, pathMappings, filesToSkip, reloadOnChange, clearConsoleOnReload,
		sourceMaps, showConsoleCallLocation, liftAccessorsFromPrototypes
	}
}

function harmonizeTrailingSlashes(pathMapping: PathMapping): PathMapping {

	if ((typeof pathMapping.url === 'string') && (typeof pathMapping.path === 'string')) {

		if (pathMapping.url.endsWith('/')) {
			if (pathMapping.path.endsWith('/')) {
				return pathMapping;
			} else {
				return { url: pathMapping.url, path: pathMapping.path + '/' };
			}
		} else {
			if (pathMapping.path.endsWith('/')) {
				return { url: pathMapping.url + '/', path: pathMapping.path };
			} else {
				return pathMapping;
			}
		}

	} else {
		return pathMapping;
	}
}

async function findFirefoxExecutable(configuredPath?: string): Promise<string> {

	if (configuredPath) {
		if (await isExecutable(configuredPath)) {
			return configuredPath;
		} else {
			throw 'Couldn\'t find the Firefox executable. Please correct the path given in your launch configuration.';
		}
	}

	let candidates: string[] = [];
	switch (os.platform()) {

		case 'linux':
		case 'freebsd':
		case 'sunos':
			const paths = process.env.PATH!.split(':');
			candidates = [
				...paths.map(dir => path.join(dir, 'firefox-developer-edition')),
				...paths.map(dir => path.join(dir, 'firefox-developer')),
				...paths.map(dir => path.join(dir, 'firefox')),
			]
			break;

		case 'darwin':
			candidates = [
				'/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
				'/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox',
				'/Applications/Firefox.app/Contents/MacOS/firefox'
			]
			break;

		case 'win32':
			candidates = [
				'C:\\Program Files (x86)\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
				'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
			]
			break;
	}

	for (let i = 0; i < candidates.length; i++) {
		if (await isExecutable(candidates[i])) {
			return candidates[i];
		}
	}

	throw 'Couldn\'t find the Firefox executable. Please specify the path by setting "firefoxExecutable" in your launch configuration.';
}

async function parseProfileConfiguration(config: LaunchConfiguration, tmpDirs: string[])
: Promise<{ profileDir: string, srcProfileDir?: string }> {

	let profileDir: string;
	let srcProfileDir: string | undefined;

	if (config.profileDir) {
		if (config.profile) {
			throw 'You can set either "profile" or "profileDir", but not both';
		}
		srcProfileDir = config.profileDir;
	} else if (config.profile) {
		srcProfileDir = await findFirefoxProfileDir(config.profile);
	}

	if (config.keepProfileChanges) {
		if (srcProfileDir) {
			profileDir = srcProfileDir;
			srcProfileDir = undefined;
		} else {
			throw 'To enable "keepProfileChanges" you need to set either "profile" or "profileDir"';
		}
	} else {
		profileDir = path.join(os.tmpdir(), `vscode-firefox-debug-profile-${uuid.v4()}`);
		tmpDirs.push(profileDir);
	}

	return { profileDir, srcProfileDir };
}

function findFirefoxProfileDir(profileName: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {

		let finder = new FirefoxProfile.Finder();

		finder.getPath(profileName, (err, path) => {
			if (err) {
				reject(err);
			} else {
				resolve(path);
			}
		});
	});
}

function createFirefoxPreferences(
	additionalPreferences?: { [key: string]: boolean | number | string | null }
): FirefoxPreferences {

	let preferences: FirefoxPreferences = {};

	// Remote debugging settings
	preferences['devtools.chrome.enabled'] = true;
	preferences['devtools.debugger.prompt-connection'] = false;
	preferences['devtools.debugger.remote-enabled'] = true;
	preferences['extensions.autoDisableScopes'] = 10;
	preferences['xpinstall.signatures.required'] = false;
	preferences['extensions.sdk.console.logLevel'] = 'all';
	// Skip check for default browser on startup
	preferences['browser.shell.checkDefaultBrowser'] = false;
	// Hide the telemetry infobar
	preferences['datareporting.policy.dataSubmissionPolicyBypassNotification'] = true;
	// Do not redirect user when a milestone upgrade of Firefox is detected
	preferences['browser.startup.homepage_override.mstone'] = 'ignore';
	// Disable the UI tour
	preferences['browser.uitour.enabled'] = false;
	// Do not warn on quitting Firefox
	preferences['browser.warnOnQuit'] = false;

	if (additionalPreferences !== undefined) {
		for (let key in additionalPreferences) {
			let value = additionalPreferences[key];
			if (value !== null) {
				preferences[key] = value;
			} else {
				delete preferences[key];
			}
		}
	}

	return preferences;
}

function parseWebRootConfiguration(config: CommonConfiguration, pathMappings: PathMappings): string | undefined {

	if (config.url) {
		if (!config.webRoot) {
			if (!config.pathMappings) {
				throw `If you set "url" you also have to set "webRoot" or "pathMappings" in the ${config.request} configuration`;
			}
			return undefined;
		} else if (!path.isAbsolute(config.webRoot) && !isAbsoluteUrl(config.webRoot)) {
			throw `The "webRoot" property in the ${config.request} configuration has to be an absolute path`;
		}

		let webRootUrl = config.url;
		if (webRootUrl.lastIndexOf('/') > 7) {
			webRootUrl = webRootUrl.substr(0, webRootUrl.lastIndexOf('/'));
		}

		let webRoot = isAbsoluteUrl(config.webRoot) ? config.webRoot : normalizePath(config.webRoot);

		pathMappings.forEach((pathMapping) => {
			const to = pathMapping.path;
			if ((typeof to === 'string') && (to.substr(0, 10) === '${webRoot}')) {
				pathMapping.path = webRoot + to.substr(10);
			}
		});

		pathMappings.push({ url: webRootUrl, path: webRoot });

		return webRoot;

	} else if (config.webRoot) {
		throw `If you set "webRoot" you also have to set "url" in the ${config.request} configuration`;
	}

	return undefined;
}

function parseSkipFilesConfiguration(config: CommonConfiguration): RegExp[] {

	let filesToSkip: RegExp[] = [];

	if (config.skipFiles) {
		config.skipFiles.forEach((glob) => {

			let minimatch = new Minimatch(glob);
			let regExp = minimatch.makeRe();

			if (regExp) {
				filesToSkip.push(regExp);
			} else {
				log.warn(`Invalid glob pattern "${glob}" specified in "skipFiles"`);
			}
		})
	}

	return filesToSkip;
}

function parseReloadConfiguration(
	reloadConfig: ReloadConfiguration | undefined
): NormalizedReloadConfiguration | undefined {

	if (reloadConfig === undefined) {
		return undefined;
	}

	const defaultDebounce = 100;

	if (typeof reloadConfig === 'string') {

		return {
			watch: [ normalizePath(reloadConfig) ],
			ignore: [],
			debounce: defaultDebounce
		};

	} else if (Array.isArray(reloadConfig)) {

		return {
			watch: reloadConfig.map(path => normalizePath(path)),
			ignore: [],
			debounce: defaultDebounce
		};

	} else {

		let _config = <DetailedReloadConfiguration>reloadConfig;

		let watch: string[];
		if (typeof _config.watch === 'string') {
			watch = [ _config.watch ];
		} else {
			watch = _config.watch;
		}

		watch = watch.map((path) => normalizePath(path));

		let ignore: string[];
		if (_config.ignore === undefined) {
			ignore = [];
		} else if (typeof _config.ignore === 'string') {
			ignore = [ _config.ignore ];
		} else {
			ignore = _config.ignore;
		}

		ignore = ignore.map((path) => normalizePath(path));

		let debounce: number;
		if (typeof _config.debounce === 'number') {
			debounce = _config.debounce;
		} else {
			debounce = (_config.debounce !== false) ? defaultDebounce : 0;
		}

		return { watch, ignore, debounce };
	}
}

async function parseAddonConfiguration(
	config: LaunchConfiguration | AttachConfiguration,
	pathMappings: PathMappings
): Promise<ParsedAddonConfiguration> {

	let addonPath = config.addonPath!;
	const popupAutohideButton = (config.popupAutohideButton !== false);

	let addonId = await findAddonId(addonPath);

	let sanitizedAddonPath = addonPath;
	if (sanitizedAddonPath[sanitizedAddonPath.length - 1] === '/') {
		sanitizedAddonPath = sanitizedAddonPath.substr(0, sanitizedAddonPath.length - 1);
	}
	pathMappings.push({
		url: new RegExp('^moz-extension://[0-9a-f-]*(/.*)$'),
		path: sanitizedAddonPath
	});

	if (addonId) {
		// this pathMapping may no longer be necessary, I haven't seen this kind of URL recently...
		let rewrittenAddonId = addonId.replace('{', '%7B').replace('}', '%7D');
		pathMappings.push({
			url: new RegExp(`^jar:file:.*/extensions/${rewrittenAddonId}.xpi!(/.*)$`),
			path: sanitizedAddonPath
		});
	}

	return {
		path: addonPath, id: addonId, popupAutohideButton
	}
}
