/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

const fs = require('node:fs');
const path = require('node:path');
const nopt = require('nopt');
const glob = require('fast-glob');
const dedent = require('dedent');
const events = require('cordova-common').events;
const AndroidManifest = require('./AndroidManifest');
const xmlHelpers = require('cordova-common').xmlHelpers;
const CordovaError = require('cordova-common').CordovaError;
const ConfigParser = require('cordova-common').ConfigParser;
const FileUpdater = require('cordova-common').FileUpdater;
const PlatformJson = require('cordova-common').PlatformJson;
const PlatformMunger = require('cordova-common').ConfigChanges.PlatformMunger;
const PluginInfoProvider = require('cordova-common').PluginInfoProvider;
const utils = require('./utils');
const gradleConfigDefaults = require('./gradle-config-defaults');
const checkReqs = require('./check_reqs');
const GradlePropertiesParser = require('./config/GradlePropertiesParser');
const CordovaGradleConfigParserFactory = require('./config/CordovaGradleConfigParserFactory');

function parseArguments (argv) {
    return nopt({
        // `jvmargs` is a valid option however, we don't actually want to parse it because we want the entire string as is.
        // jvmargs: String
    }, {}, argv || [], 0);
}

module.exports.prepare = function (cordovaProject, options) {
    const self = this;

    let args = {};
    if (options && options.options) {
        args = parseArguments(options.options.argv);
    }

    const platformJson = PlatformJson.load(this.locations.root, this.platform);
    const munger = new PlatformMunger(this.platform, this.locations.root, platformJson, new PluginInfoProvider());

    this._config = updateConfigFilesFrom(cordovaProject.projectConfig, munger, this.locations);

    // Update Gradle cdv-gradle-config.json
    updateUserProjectGradleConfig(this);

    // Update Project's Gradle Properties
    updateUserProjectGradlePropertiesConfig(this, args);

    // Update own www dir with project's www assets and plugins' assets and js-files
    return Promise.resolve(updateWww(cordovaProject, this.locations))
        .then(() => warnForDeprecatedSplashScreen(cordovaProject))
        .then(() => updateProjectAccordingTo(self._config, self.locations))
        .then(function () {
            updateIcons(cordovaProject, path.relative(cordovaProject.root, self.locations.res));
            updateFileResources(cordovaProject, path.relative(cordovaProject.root, self.locations.root));
        }).then(function () {
            events.emit('verbose', 'Prepared android project successfully');
        });
};

/** @param {PlatformApi} project */
function updateUserProjectGradleConfig (project) {
    // Generate project gradle config
    const projectGradleConfig = {
        ...gradleConfigDefaults,
        ...getUserGradleConfig(project._config)
    };

    // Check if compile sdk is valid.
    // The returned result is iggnored and since we do not need and will not throw  an error.
    // Only using the valid check call for display the warning when target is greater then compiled.
    checkReqs.isCompileSdkValid(
        projectGradleConfig.COMPILE_SDK_VERSION,
        projectGradleConfig.SDK_VERSION
    );

    // Write out changes
    const projectGradleConfigPath = path.join(project.root, 'cdv-gradle-config.json');
    fs.writeFileSync(projectGradleConfigPath, JSON.stringify(projectGradleConfig, null, 2), 'utf-8');
}

function getUserGradleConfig (configXml) {
    const configXmlToGradleMapping = [
        { xmlKey: 'android-minSdkVersion', gradleKey: 'MIN_SDK_VERSION', type: Number },
        { xmlKey: 'android-maxSdkVersion', gradleKey: 'MAX_SDK_VERSION', type: Number },
        { xmlKey: 'android-targetSdkVersion', gradleKey: 'SDK_VERSION', type: Number },
        { xmlKey: 'android-compileSdkVersion', gradleKey: 'COMPILE_SDK_VERSION', type: Number },
        { xmlKey: 'android-buildToolsVersion', gradleKey: 'BUILD_TOOLS_VERSION', type: String },
        { xmlKey: 'GradleVersion', gradleKey: 'GRADLE_VERSION', type: String },
        { xmlKey: 'AndroidGradlePluginVersion', gradleKey: 'AGP_VERSION', type: String },
        { xmlKey: 'GradlePluginKotlinVersion', gradleKey: 'KOTLIN_VERSION', type: String },
        { xmlKey: 'AndroidXAppCompatVersion', gradleKey: 'ANDROIDX_APP_COMPAT_VERSION', type: String },
        { xmlKey: 'AndroidXWebKitVersion', gradleKey: 'ANDROIDX_WEBKIT_VERSION', type: String },
        { xmlKey: 'GradlePluginGoogleServicesVersion', gradleKey: 'GRADLE_PLUGIN_GOOGLE_SERVICES_VERSION', type: String },
        { xmlKey: 'GradlePluginGoogleServicesEnabled', gradleKey: 'IS_GRADLE_PLUGIN_GOOGLE_SERVICES_ENABLED', type: Boolean },
        { xmlKey: 'GradlePluginKotlinEnabled', gradleKey: 'IS_GRADLE_PLUGIN_KOTLIN_ENABLED', type: Boolean },
        { xmlKey: 'AndroidJavaSourceCompatibility', gradleKey: 'JAVA_SOURCE_COMPATIBILITY', type: Number },
        { xmlKey: 'AndroidJavaTargetCompatibility', gradleKey: 'JAVA_TARGET_COMPATIBILITY', type: Number },
        { xmlKey: 'AndroidKotlinJVMTarget', gradleKey: 'KOTLIN_JVM_TARGET', type: String }
    ];

    return configXmlToGradleMapping.reduce((config, mapping) => {
        const rawValue = configXml.getPreference(mapping.xmlKey, 'android');

        // ignore missing preferences (which occur as '')
        if (rawValue) {
            config[mapping.gradleKey] = parseStringAsType(rawValue, mapping.type);
        }

        return config;
    }, {});
}

/** Converts given string to given type */
function parseStringAsType (value, type) {
    switch (type) {
    case String:
        return String(value);
    case Number:
        return parseFloat(value);
    case Boolean:
        return value.toLowerCase() === 'true';
    default:
        throw new CordovaError('Invalid type: ' + type);
    }
}

function updateUserProjectGradlePropertiesConfig (project, args) {
    const gradlePropertiesUserConfig = {};

    // Get the min SDK version from config.xml
    if (args.jvmargs) gradlePropertiesUserConfig['org.gradle.jvmargs'] = args.jvmargs;

    const isGradlePluginKotlinEnabled = project._config.getPreference('GradlePluginKotlinEnabled', 'android');
    if (isGradlePluginKotlinEnabled) {
        const gradlePluginKotlinCodeStyle = project._config.getPreference('GradlePluginKotlinCodeStyle', 'android');
        gradlePropertiesUserConfig['kotlin.code.style'] = gradlePluginKotlinCodeStyle || 'official';
    }

    const gradlePropertiesParser = new GradlePropertiesParser(project.root);
    gradlePropertiesParser.configure(gradlePropertiesUserConfig);
}

module.exports.clean = function (options) {
    // A cordovaProject isn't passed into the clean() function, because it might have
    // been called from the platform shell script rather than the CLI. Check for the
    // noPrepare option passed in by the non-CLI clean script. If that's present, or if
    // there's no config.xml found at the project root, then don't clean prepared files.
    const projectRoot = path.resolve(this.root, '../..');
    if ((options && options.noPrepare) || !fs.existsSync(this.locations.configXml) ||
            !fs.existsSync(this.locations.configXml)) {
        return Promise.resolve();
    }

    const projectConfig = new ConfigParser(this.locations.configXml);

    const self = this;
    return Promise.resolve().then(function () {
        cleanWww(projectRoot, self.locations);
        cleanIcons(projectRoot, projectConfig, path.relative(projectRoot, self.locations.res));
        cleanFileResources(projectRoot, projectConfig, path.relative(projectRoot, self.locations.root));
    });
};

/**
 * Updates config files in project based on app's config.xml and config munge,
 *   generated by plugins.
 *
 * @param   {ConfigParser}   sourceConfig  A project's configuration that will
 *   be merged into platform's config.xml
 * @param   {ConfigChanges}  configMunger  An initialized ConfigChanges instance
 *   for this platform.
 * @param   {Object}         locations     A map of locations for this platform
 *
 * @return  {ConfigParser}                 An instance of ConfigParser, that
 *   represents current project's configuration. When returned, the
 *   configuration is already dumped to appropriate config.xml file.
 */
function updateConfigFilesFrom (sourceConfig, configMunger, locations) {
    events.emit('verbose', 'Generating platform-specific config.xml from defaults for android at ' + locations.configXml);

    // First cleanup current config and merge project's one into own
    // Overwrite platform config.xml with defaults.xml.
    fs.cpSync(locations.defaultConfigXml, locations.configXml);

    // Then apply config changes from global munge to all config files
    // in project (including project's config)
    configMunger.reapply_global_munge().save_all();

    events.emit('verbose', 'Merging project\'s config.xml into platform-specific android config.xml');
    // Merge changes from app's config.xml into platform's one
    const config = new ConfigParser(locations.configXml);
    xmlHelpers.mergeXml(sourceConfig.doc.getroot(),
        config.doc.getroot(), 'android', /* clobber= */true);

    config.write();
    return config;
}

/**
 * Logs all file operations via the verbose event stream, indented.
 */
function logFileOp (message) {
    events.emit('verbose', '  ' + message);
}

/**
 * Updates platform 'www' directory by replacing it with contents of
 *   'platform_www' and app www. Also copies project's overrides' folder into
 *   the platform 'www' folder
 *
 * @param   {Object}  cordovaProject    An object which describes cordova project.
 * @param   {Object}  destinations      An object that contains destination
 *   paths for www files.
 */
function updateWww (cordovaProject, destinations) {
    const sourceDirs = [
        path.relative(cordovaProject.root, cordovaProject.locations.www),
        path.relative(cordovaProject.root, destinations.platformWww)
    ];

    // If project contains 'merges' for our platform, use them as another overrides
    const merges_path = path.join(cordovaProject.root, 'merges', 'android');
    if (fs.existsSync(merges_path)) {
        events.emit('verbose', 'Found "merges/android" folder. Copying its contents into the android project.');
        sourceDirs.push(path.join('merges', 'android'));
    }

    const targetDir = path.relative(cordovaProject.root, destinations.www);
    events.emit(
        'verbose', 'Merging and updating files from [' + sourceDirs.join(', ') + '] to ' + targetDir);
    FileUpdater.mergeAndUpdateDir(
        sourceDirs, targetDir, { rootDir: cordovaProject.root }, logFileOp);
}

/**
 * Cleans all files from the platform 'www' directory.
 */
function cleanWww (projectRoot, locations) {
    const targetDir = path.relative(projectRoot, locations.www);
    events.emit('verbose', 'Cleaning ' + targetDir);

    // No source paths are specified, so mergeAndUpdateDir() will clear the target directory.
    FileUpdater.mergeAndUpdateDir(
        [], targetDir, { rootDir: projectRoot, all: true }, logFileOp);
}

/**
 * Updates project structure and AndroidManifest according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectAccordingTo (platformConfig, locations) {
    updateProjectStrings(platformConfig, locations);
    updateProjectTheme(platformConfig, locations);

    const name = platformConfig.name();

    // Update app name for gradle project
    fs.writeFileSync(path.join(locations.root, 'cdv-gradle-name.gradle'),
        '// GENERATED FILE - DO NOT EDIT\n' +
        'rootProject.name = "' + name.replace(/[/\\:<>"?*|]/g, '_') + '"\n');

    // Java packages cannot support dashes
    const androidPkgName = (platformConfig.android_packageName() || platformConfig.packageName()).replace(/-/g, '_');

    // updating cdv-gradle-config with new androidPkgName.
    const cdvGradleConfig = CordovaGradleConfigParserFactory.create(locations.root);
    cdvGradleConfig.setPackageName(androidPkgName)
        .write();

    const manifest = new AndroidManifest(locations.manifest);
    manifest.getActivity()
        .setOrientation(platformConfig.getPreference('orientation'))
        .setLaunchMode(findAndroidLaunchModePreference(platformConfig));

    manifest.setVersionName(platformConfig.version())
        .setVersionCode(platformConfig.android_versionCode() || default_versionCode(platformConfig.version()))
        .write();

    // Java file paths shouldn't be hard coded
    const javaDirectory = path.join(locations.javaSrc, androidPkgName.replace(/\./g, '/'));
    const java_files = glob.sync('**/*.java', { cwd: javaDirectory, absolute: true }).filter(f => {
        const contents = fs.readFileSync(f, 'utf-8');
        return /extends\s+CordovaActivity/.test(contents);
    });

    if (java_files.length === 0) {
        throw new CordovaError('No Java files found that extend CordovaActivity.');
    } else if (java_files.length > 1) {
        events.emit('log', 'Multiple candidate Java files that extend CordovaActivity found. Guessing at the first one, ' + java_files[0]);
    }

    const destFile = path.normalize(java_files[0]);

    // if package name has changed, path to MainActivity.java has to track it
    const newDestFile = path.join(locations.root, 'app', 'src', 'main', 'java', androidPkgName.replace(/\./g, '/'), path.basename(destFile));
    if (newDestFile.toLowerCase() !== destFile.toLowerCase()) {
        // If package was name changed we need to create new java with main activity in path matching new package name
        fs.mkdirSync(path.dirname(newDestFile), { recursive: true });
        events.emit('verbose', `copy ${destFile} to ${newDestFile}`);
        fs.cpSync(destFile, newDestFile);
        utils.replaceFileContents(newDestFile, /package [\w.]*;/, 'package ' + androidPkgName + ';');
        events.emit('verbose', 'Wrote out Android package name "' + androidPkgName + '" to ' + newDestFile);
        // If package was name changed we need to remove old java with main activity
        events.emit('verbose', `remove ${destFile}`);
        fs.rmSync(destFile);
        // remove any empty directories
        let currentDir = path.dirname(destFile);
        const sourcesRoot = path.resolve(locations.root, 'src');
        while (currentDir !== sourcesRoot) {
            if (fs.existsSync(currentDir) && fs.readdirSync(currentDir).length === 0) {
                fs.rmdirSync(currentDir);
                currentDir = path.resolve(currentDir, '..');
            } else {
                break;
            }
        }
    }
}

/**
 * Updates project structure and AndroidManifest according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectStrings (platformConfig, locations) {
    // Update app name by editing res/values/cdv_strings.xml
    const strings = xmlHelpers.parseElementtreeSync(locations.strings);

    const name = platformConfig.name();
    strings.find('string[@name="app_name"]').text = name.replace(/'/g, '\\\'');

    const shortName = platformConfig.shortName && platformConfig.shortName();
    if (shortName && shortName !== name) {
        strings.find('string[@name="launcher_name"]').text = shortName.replace(/'/g, '\\\'');
    }

    fs.writeFileSync(locations.strings, strings.write({ indent: 4 }), 'utf-8');
    events.emit('verbose', 'Wrote out android application name "' + name + '" to ' + locations.strings);
}

function warnForDeprecatedSplashScreen (cordovaProject) {
    const hasOldSplashTags = (
        cordovaProject.projectConfig.doc.findall('./platform[@name="android"]/splash') || []
    ).length > 0;

    if (hasOldSplashTags) {
        events.emit('warn', 'The "<splash>" tags were detected and are no longer supported. Please migrate to the "preference" tag "AndroidWindowSplashScreenAnimatedIcon".');
    }
}

/**
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectTheme (platformConfig, locations) {
    // res/values/cdv_themes.xml
    const themes = xmlHelpers.parseElementtreeSync(locations.themes);
    const splashScreenTheme = themes.find('style[@name="Theme.App.SplashScreen"]');

    // Update edge-to-edge settings in app theme.
    let hasE2E = false; // default case

    const preferenceE2E = platformConfig.getPreference('AndroidEdgeToEdge', this.platform);
    if (!preferenceE2E) {
        events.emit('verbose', 'The preference name "AndroidEdgeToEdge" was not set. Defaulting to "false".');
    } else {
        const hasInvalidPreferenceE2E = preferenceE2E !== 'true' && preferenceE2E !== 'false';
        if (hasInvalidPreferenceE2E) {
            events.emit('verbose', 'Preference name "AndroidEdgeToEdge" has an invalid value. Valid values are "true" or "false". Defaulting to "false"');
        }
        hasE2E = hasInvalidPreferenceE2E ? false : preferenceE2E === 'true';
    }

    const optOutE2EKey = 'android:windowOptOutEdgeToEdgeEnforcement';
    const optOutE2EItem = splashScreenTheme.find(`item[@name="${optOutE2EKey}"]`);
    const optOutE2EValue = !hasE2E ? 'true' : 'false';
    optOutE2EItem.text = optOutE2EValue;
    events.emit('verbose', `Updating theme item "${optOutE2EKey}" with value "${optOutE2EValue}"`);

    let splashBg = platformConfig.getPreference('AndroidWindowSplashScreenBackground', this.platform);
    if (!splashBg) {
        splashBg = platformConfig.getPreference('SplashScreenBackgroundColor', this.platform);
    }
    if (!splashBg) {
        splashBg = platformConfig.getPreference('BackgroundColor', this.platform);
    }
    if (!splashBg) {
        splashBg = '@color/cdv_splashscreen_background';
    }

    events.emit('verbose', 'The Android Splash Screen background color was set to: ' +
        (splashBg === '@color/cdv_splashscreen_background' ? 'Default' : splashBg)
    );

    // force the themes value to `@color/cdv_splashscreen_background`
    const splashBgNode = splashScreenTheme.find('item[@name="windowSplashScreenBackground"]');
    splashBgNode.text = splashBg;

    [
        // Splash Screen
        'windowSplashScreenAnimatedIcon',
        'windowSplashScreenAnimationDuration',
        'android:windowSplashScreenBrandingImage',
        'windowSplashScreenIconBackgroundColor',
        'postSplashScreenTheme'
    ].forEach(themeKey => {
        const index = themeKey.indexOf(':') + 1;
        const cdvConfigPrefKey = 'Android' + themeKey.charAt(index).toUpperCase() + themeKey.slice(index + 1);
        const cdvConfigPrefValue = platformConfig.getPreference(cdvConfigPrefKey, this.platform);
        let themeTargetNode = splashScreenTheme.find(`item[@name="${themeKey}"]`);

        switch (themeKey) {
        case 'windowSplashScreenAnimatedIcon':
            // handle here the cases of "png" vs "xml" (drawable)
            // If "png":
            //  - Clear out default or previous set "drawable/ic_cdv_splashscreen.xml" if exisiting.
            //  - Copy png in correct mipmap dir with name "ic_cdv_splashscreen.png"
            // If "xml":
            //  - Clear out "{mipmap}/ic_cdv_splashscreen.png" if exisiting.
            //  - Copy xml into drawable dir with name "ic_cdv_splashscreen.xml"

            // updateProjectSplashScreenIcon()
            // value should change depending on case:
            // If "png": "@mipmap/ic_cdv_splashscreen"
            // If "xml": "@drawable/ic_cdv_splashscreen"
            updateProjectSplashScreenImage(locations, themeKey, cdvConfigPrefKey, cdvConfigPrefValue);
            break;

        case 'android:windowSplashScreenBrandingImage':
            // display warning only when set.
            if (cdvConfigPrefValue) {
                events.emit('warn', `"${themeKey}" is currently not supported by the splash screen compatibility library. https://issuetracker.google.com/issues/194301890`);
            }

            updateProjectSplashScreenImage(locations, themeKey, cdvConfigPrefKey, cdvConfigPrefValue);

            // force the themes value to `@color/cdv_splashscreen_icon_background`
            if (!cdvConfigPrefValue && themeTargetNode) {
                splashScreenTheme.remove(themeTargetNode);
                delete themes.getroot().attrib['xmlns:tools'];
            } else if (cdvConfigPrefValue) {
                // if there is no current node, create a new node.
                if (!themeTargetNode) {
                    themeTargetNode = themes.getroot().makeelement('item', { name: themeKey, 'tools:targetApi': '31' });
                    splashScreenTheme.append(themeTargetNode);
                    themes.getroot().attrib['xmlns:tools'] = 'http://schemas.android.com/tools';
                }
                // set the user defined color.
                themeTargetNode.text = '@drawable/ic_cdv_splashscreen_branding';
            }
            break;

        case 'windowSplashScreenIconBackgroundColor':
            // use the user defined value for "cdv_colors.xml"
            updateProjectSplashScreenIconBackgroundColor(cdvConfigPrefValue, locations);

            // force the themes value to `@color/cdv_splashscreen_icon_background`
            if (!cdvConfigPrefValue && themeTargetNode) {
                // currentItem.remove();
                splashScreenTheme.remove(themeTargetNode);
            } else if (cdvConfigPrefValue) {
                // if there is no current color, create a new node.
                if (!themeTargetNode) {
                    themeTargetNode = themes.getroot().makeelement('item', { name: themeKey });
                    splashScreenTheme.append(themeTargetNode);
                }

                // set the user defined color.
                themeTargetNode.text = '@color/cdv_splashscreen_icon_background';
            }
            break;

        case 'windowSplashScreenAnimationDuration':
            themeTargetNode.text = cdvConfigPrefValue || '200';
            break;

        case 'postSplashScreenTheme':
            themeTargetNode.text = cdvConfigPrefValue || '@style/Theme.Cordova.App.DayNight';
            break;

        default:
            events.emit('warn', `The theme property "${themeKey}" does not exist`);
        }
    });

    fs.writeFileSync(locations.themes, themes.write({ indent: 4 }), 'utf-8');
    events.emit('verbose', 'Wrote out Android application themes to ' + locations.themes);
}

/**
 * @param   {String}  splashIconBackgroundColor  SplashScreen Icon Background Color Hex Code
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectSplashScreenIconBackgroundColor (splashIconBackgroundColor, locations) {
    // res/values/cdv_colors.xml
    const colors = xmlHelpers.parseElementtreeSync(locations.colors);
    // node name
    const name = 'cdv_splashscreen_icon_background';

    // get the current defined color
    let currentColor = colors.find(`color[@name="${name}"]`);

    if (!splashIconBackgroundColor && currentColor) {
        colors.getroot().remove(currentColor);
    } else if (splashIconBackgroundColor) {
        // if there is no current color, create a new node.
        if (!currentColor) {
            currentColor = colors.getroot().makeelement('color', { name });
            colors.getroot().append(currentColor);
        }

        // set the user defined color.
        currentColor.text = splashIconBackgroundColor.replace(/'/g, '\\\'');
    }

    // write out the changes.
    fs.writeFileSync(locations.colors, colors.write({ indent: 4 }), 'utf-8');
    events.emit('verbose', 'Wrote out Android application SplashScreen Icon Color to ' + locations.colors);
}

function cleanupAndSetProjectSplashScreenImage (srcFile, destFilePath, possiblePreviousDestFilePath, cleanupOnly = false) {
    if (fs.existsSync(possiblePreviousDestFilePath)) {
        fs.rmSync(possiblePreviousDestFilePath);
    }

    if (cleanupOnly && fs.existsSync(destFilePath)) {
        // Also remove dest file path for cleanup even if previous was not use.
        fs.rmSync(destFilePath);
    }

    if (!cleanupOnly && srcFile && fs.existsSync(srcFile)) {
        fs.cpSync(srcFile, destFilePath);
    }
}

function updateProjectSplashScreenImage (locations, themeKey, cdvConfigPrefKey, cdvConfigPrefValue = '') {
    const SPLASH_SCREEN_IMAGE_BY_THEME_KEY = {
        windowSplashScreenAnimatedIcon: 'ic_cdv_splashscreen',
        'android:windowSplashScreenBrandingImage': 'ic_cdv_splashscreen_branding'
    };

    const destFileName = SPLASH_SCREEN_IMAGE_BY_THEME_KEY[themeKey] || null;
    if (!destFileName) throw new CordovaError(`${themeKey} is not valid for image detection.`);

    // Default paths of where images are saved
    const destPngDir = path.join(locations.res, 'drawable-nodpi');
    const destXmlDir = path.join(locations.res, 'drawable');

    // Dest File Name and Path
    const destFileNameExt = destFileName + '.xml';
    let destFilePath = path.join(destXmlDir, destFileNameExt);
    let possiblePreviousDestFilePath = path.join(destPngDir, destFileName + '.png');

    // Default Drawable Source File
    let defaultSrcFilePath = null;

    if (themeKey !== 'android:windowSplashScreenBrandingImage') {
        try {
            // coming from user project
            defaultSrcFilePath = require.resolve('cordova-android/templates/project/res/drawable/' + destFileNameExt);
        } catch (e) {
            // coming from repo test & coho
            defaultSrcFilePath = require.resolve('../templates/project/res/drawable/' + destFileNameExt);
        }
    }

    if (!cdvConfigPrefValue || !fs.existsSync(cdvConfigPrefValue)) {
        let emitType = 'verbose';
        let emmitMessage = `The "${cdvConfigPrefKey}" is undefined. Cordova's default will be used.`;

        if (cdvConfigPrefValue && !fs.existsSync(cdvConfigPrefValue)) {
            emitType = 'warn';
            emmitMessage = `The "${cdvConfigPrefKey}" value does not exist. Cordova's default will be used.`;
        }

        events.emit(emitType, emmitMessage);
        const cleanupOnly = themeKey === 'android:windowSplashScreenBrandingImage';
        cleanupAndSetProjectSplashScreenImage(defaultSrcFilePath, destFilePath, possiblePreviousDestFilePath, cleanupOnly);
        return;
    }

    const iconExtension = path.extname(cdvConfigPrefValue).toLowerCase();

    if (iconExtension === '.png') {
        // Put the image at this location.
        destFilePath = path.join(destPngDir, destFileName + '.png');

        // Check for this file and remove.
        possiblePreviousDestFilePath = path.join(destXmlDir, destFileName + '.xml');

        // copy the png to correct mipmap folder with name of ic_cdv_splashscreen.png
        // delete ic_cdv_splashscreen.xml from drawable folder
        // update cdv_themes.xml windowSplashScreenAnimatedIcon value to @mipmap/ic_cdv_splashscreen
        cleanupAndSetProjectSplashScreenImage(cdvConfigPrefValue, destFilePath, possiblePreviousDestFilePath);
    } else if (iconExtension === '.xml') {
        // copy the xml to drawable folder with name of ic_cdv_splashscreen.xml
        // delete ic_cdv_splashscreen.png from mipmap folder
        // update cdv_themes.xml windowSplashScreenAnimatedIcon value to @drawable/ic_cdv_splashscreen
        cleanupAndSetProjectSplashScreenImage(cdvConfigPrefValue, destFilePath, possiblePreviousDestFilePath);
    } else {
        // use the default destFilePath & possiblePreviousDestFilePath, no update require.
        events.emit('warn', `The "${cdvConfigPrefKey}" had an unsupported extension. Cordova's default will be used.`);
        cleanupAndSetProjectSplashScreenImage(defaultSrcFilePath, destFilePath, possiblePreviousDestFilePath);
    }
}

// Consturct the default value for versionCode as
// PATCH + MINOR * 100 + MAJOR * 10000
// see http://developer.android.com/tools/publishing/versioning.html
function default_versionCode (version) {
    const nums = version.split('-')[0].split('.');
    let versionCode = 0;
    if (+nums[0]) {
        versionCode += +nums[0] * 10000;
    }
    if (+nums[1]) {
        versionCode += +nums[1] * 100;
    }
    if (+nums[2]) {
        versionCode += +nums[2];
    }

    events.emit('verbose', 'android-versionCode not found in config.xml. Generating a code based on version in config.xml (' + version + '): ' + versionCode);
    return versionCode;
}

function getImageResourcePath (resourcesDir, type, density, name, sourceName) {
    // Use same extension as source with special case for 9-Patch files
    const ext = sourceName.endsWith('.9.png')
        ? '.9.png'
        : path.extname(sourceName).toLowerCase();

    const subDir = density ? `${type}-${density}` : type;
    return path.join(resourcesDir, subDir, name + ext);
}

function getAdaptiveImageResourcePath (resourcesDir, type, density, name, sourceName) {
    if (/\.9\.png$/.test(sourceName)) {
        name = name.replace(/\.png$/, '.9.png');
    }
    const resourcePath = path.join(resourcesDir, (density ? type + '-' + density + '-v26' : type), name);
    return resourcePath;
}

function updateIcons (cordovaProject, platformResourcesDir) {
    const icons = cordovaProject.projectConfig.getIcons('android');

    // Skip if there are no app defined icons in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    // 1. loop icons determin if there is an error in the setup.
    // 2. during initial loop, also setup for legacy support.
    const errorMissingAttributes = [];
    const errorLegacyIconNeeded = [];
    let hasAdaptive = false;
    icons.forEach((icon, key) => {
        if (
            (icon.background && !icon.foreground) ||
            (!icon.background && icon.foreground) ||
            (!icon.background && !icon.foreground && !icon.src)
        ) {
            errorMissingAttributes.push(icon.density ? icon.density : 'size=' + (icon.height || icon.width));
        }

        if (icon.foreground) {
            hasAdaptive = true;

            if (
                !icon.src &&
                (
                    icon.foreground.startsWith('@color') ||
                    path.extname(path.basename(icon.foreground)) === '.xml'
                )
            ) {
                errorLegacyIconNeeded.push(icon.density ? icon.density : 'size=' + (icon.height || icon.width));
            } else if (!icon.src) {
                icons[key].src = icon.foreground;
            }
        }
    });

    const errorMessage = [];
    if (errorMissingAttributes.length > 0) {
        errorMessage.push('One of the following attributes are set but missing the other for the density type: ' + errorMissingAttributes.join(', ') + '. Please ensure that all require attributes are defined.');
    }

    if (errorLegacyIconNeeded.length > 0) {
        errorMessage.push('For the following icons with the density of: ' + errorLegacyIconNeeded.join(', ') + ', adaptive foreground with a defined color or vector can not be used as a standard fallback icon for older Android devices. To support older Android environments, please provide a value for the src attribute.');
    }

    if (errorMessage.length > 0) {
        throw new CordovaError(errorMessage.join(' '));
    }

    let resourceMap = Object.assign(
        {},
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher.png'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_foreground.png'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_background.png'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_monochrome.png'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_foreground.xml'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_background.xml'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher_monochrome.xml'),
        mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'ic_launcher.xml')
    );

    const preparedIcons = prepareIcons(icons);

    if (hasAdaptive) {
        resourceMap = updateIconResourceForAdaptive(preparedIcons, resourceMap, platformResourcesDir);
    }

    resourceMap = updateIconResourceForLegacy(preparedIcons, resourceMap, platformResourcesDir);

    events.emit('verbose', 'Updating icons at ' + platformResourcesDir);
    FileUpdater.updatePaths(resourceMap, { rootDir: cordovaProject.root }, logFileOp);
}

function updateIconResourceForAdaptive (preparedIcons, resourceMap, platformResourcesDir) {
    const android_icons = preparedIcons.android_icons;
    const default_icon = preparedIcons.default_icon;

    // The source paths for icons are relative to
    // project's config.xml location, so we use it as base path.
    let background;
    let foreground;
    let monochrome;
    let targetPathBackground;
    let targetPathForeground;
    let targetPathMonochrome;

    for (const density in android_icons) {
        let backgroundVal = '@mipmap/ic_launcher_background';
        let foregroundVal = '@mipmap/ic_launcher_foreground';
        const monochromeVal = '@mipmap/ic_launcher_monochrome';

        background = android_icons[density].background;
        foreground = android_icons[density].foreground;
        monochrome = android_icons[density].monochrome;

        const hasAdaptiveIcons = !!background && !!foreground;
        let hasMonochromeIcon = !!monochrome;

        if (hasMonochromeIcon && !hasAdaptiveIcons) {
            // If we have a monochrome icon, but no adaptive icons,
            // then warn that in order to use monochrome, the adaptive icons
            // must be supplied. We will ignore monochrome and proceed with the
            // icon preparation however.
            hasMonochromeIcon = false;
            monochrome = undefined;
            events.emit('warn', dedent`
                Monochrome icon found but without adaptive properties.
                Monochrome icon requires the adaptive background and foreground assets.
                See https://cordova.apache.org/docs/en/latest/config_ref/images.html fore more information.
            `);
        }

        if (!hasAdaptiveIcons) {
            // This icon isn't an adaptive icon, so skip it
            continue;
        }

        if (background.startsWith('@color')) {
            // Colors Use Case
            backgroundVal = background; // Example: @color/background_foobar_1
        } else if (path.extname(path.basename(background)) === '.xml') {
            // Vector Use Case
            targetPathBackground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_background.xml', path.basename(android_icons[density].background));
            resourceMap[targetPathBackground] = android_icons[density].background;
        } else if (path.extname(path.basename(background)) === '.png') {
            // Images Use Case
            targetPathBackground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_background.png', path.basename(android_icons[density].background));
            resourceMap[targetPathBackground] = android_icons[density].background;
        }

        if (foreground.startsWith('@color')) {
            // Colors Use Case
            foregroundVal = foreground;
        } else if (path.extname(path.basename(foreground)) === '.xml') {
            // Vector Use Case
            targetPathForeground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_foreground.xml', path.basename(android_icons[density].foreground));
            resourceMap[targetPathForeground] = android_icons[density].foreground;
        } else if (path.extname(path.basename(foreground)) === '.png') {
            // Images Use Case
            targetPathForeground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_foreground.png', path.basename(android_icons[density].foreground));
            resourceMap[targetPathForeground] = android_icons[density].foreground;
        }

        if (hasMonochromeIcon) {
            if (path.extname(path.basename(monochrome)) === '.xml') {
                // Vector Use Case
                targetPathMonochrome = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_monochrome.xml', path.basename(android_icons[density].monochrome));
                resourceMap[targetPathMonochrome] = android_icons[density].monochrome;
            } else if (path.extname(path.basename(monochrome)) === '.png') {
                // Images Use Case
                targetPathMonochrome = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher_monochrome.png', path.basename(android_icons[density].monochrome));
                resourceMap[targetPathMonochrome] = android_icons[density].monochrome;
            }
        }

        // create an XML for DPI and set color
        let icLauncherTemplate = '';
        if (hasMonochromeIcon) {
            icLauncherTemplate = dedent`
                <?xml version="1.0" encoding="utf-8"?>
                <adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
                    <background android:drawable="${backgroundVal}" />
                    <foreground android:drawable="${foregroundVal}" />
                    <monochrome android:drawable="${monochromeVal}" />
                </adaptive-icon>
            `;
        } else {
            icLauncherTemplate = dedent`
                <?xml version="1.0" encoding="utf-8"?>
                <adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
                    <background android:drawable="${backgroundVal}" />
                    <foreground android:drawable="${foregroundVal}" />
                </adaptive-icon>
            `;
        }

        const launcherXmlPath = path.join(platformResourcesDir, 'mipmap-' + density + '-v26', 'ic_launcher.xml');

        // Remove the XML from the resourceMap so the file does not get removed.
        delete resourceMap[launcherXmlPath];

        fs.writeFileSync(path.resolve(launcherXmlPath), icLauncherTemplate);
    }

    // There's no "default" drawable, so assume default == mdpi.
    if (default_icon && !android_icons.mdpi) {
        let defaultTargetPathBackground;
        let defaultTargetPathForeground;
        let defaultTargetPathMonochrome;

        if (background.startsWith('@color')) {
            // Colors Use Case
            targetPathBackground = default_icon.background;
        } else if (path.extname(path.basename(background)) === '.xml') {
            // Vector Use Case
            defaultTargetPathBackground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_background.xml', path.basename(default_icon.background));
            resourceMap[defaultTargetPathBackground] = default_icon.background;
        } else if (path.extname(path.basename(background)) === '.png') {
            // Images Use Case
            defaultTargetPathBackground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_background.png', path.basename(default_icon.background));
            resourceMap[defaultTargetPathBackground] = default_icon.background;
        }

        if (foreground.startsWith('@color')) {
            // Colors Use Case
            targetPathForeground = default_icon.foreground;
        } else if (path.extname(path.basename(foreground)) === '.xml') {
            // Vector Use Case
            defaultTargetPathForeground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_foreground.xml', path.basename(default_icon.foreground));
            resourceMap[defaultTargetPathForeground] = default_icon.foreground;
        } else if (path.extname(path.basename(foreground)) === '.png') {
            // Images Use Case
            defaultTargetPathForeground = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_foreground.png', path.basename(default_icon.foreground));
            resourceMap[defaultTargetPathForeground] = default_icon.foreground;
        }

        if (monochrome) {
            if (path.extname(path.basename(monochrome)) === '.xml') {
                // Vector Use Case
                defaultTargetPathMonochrome = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_monochrome.xml', path.basename(default_icon.monochrome));
                resourceMap[defaultTargetPathMonochrome] = default_icon.monochrome;
            } else if (path.extname(path.basename(monochrome)) === '.png') {
                // Images Use Case
                defaultTargetPathMonochrome = getAdaptiveImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher_monochrome.png', path.basename(default_icon.monochrome));
                resourceMap[defaultTargetPathMonochrome] = default_icon.monochrome;
            }
        }
    }

    return resourceMap;
}

function updateIconResourceForLegacy (preparedIcons, resourceMap, platformResourcesDir) {
    const android_icons = preparedIcons.android_icons;
    const default_icon = preparedIcons.default_icon;

    // The source paths for icons are relative to
    // project's config.xml location, so we use it as base path.
    for (const density in android_icons) {
        const targetPath = getImageResourcePath(platformResourcesDir, 'mipmap', density, 'ic_launcher', path.basename(android_icons[density].src));
        resourceMap[targetPath] = android_icons[density].src;
    }

    // There's no "default" drawable, so assume default == mdpi.
    if (default_icon && !android_icons.mdpi) {
        const defaultTargetPath = getImageResourcePath(platformResourcesDir, 'mipmap', 'mdpi', 'ic_launcher', path.basename(default_icon.src));
        resourceMap[defaultTargetPath] = default_icon.src;
    }

    return resourceMap;
}

function prepareIcons (icons) {
    // http://developer.android.com/design/style/iconography.html
    const SIZE_TO_DENSITY_MAP = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };

    const android_icons = {};
    let default_icon;

    // find the best matching icon for a given density or size
    // @output android_icons
    const parseIcon = function (icon, icon_size) {
        // do I have a platform icon for that density already
        const density = icon.density || SIZE_TO_DENSITY_MAP[icon_size];
        if (!density) {
            // invalid icon defition ( or unsupported size)
            return;
        }
        const previous = android_icons[density];
        if (previous && previous.platform) {
            return;
        }
        android_icons[density] = icon;
    };

    // iterate over all icon elements to find the default icon and call parseIcon
    for (let i = 0; i < icons.length; i++) {
        const icon = icons[i];
        let size = icon.width;

        if (!size) {
            size = icon.height;
        }

        if (!size && !icon.density) {
            if (default_icon) {
                const found = {};
                const favor = {};

                // populating found icon.
                if (icon.background && icon.foreground && icon.monochrome) {
                    found.background = icon.background;
                    found.foreground = icon.foreground;
                    found.monochrome = icon.monochrome;
                }
                if (icon.background && icon.foreground) {
                    found.background = icon.background;
                    found.foreground = icon.foreground;
                }
                if (icon.src) {
                    found.src = icon.src;
                }

                if (default_icon.background && default_icon.foreground && default_icon.monochrome) {
                    favor.background = default_icon.background;
                    favor.foreground = default_icon.foreground;
                    favor.monochrome = default_icon.monochrome;
                }
                if (default_icon.background && default_icon.foreground) {
                    favor.background = default_icon.background;
                    favor.foreground = default_icon.foreground;
                }
                if (default_icon.src) {
                    favor.src = default_icon.src;
                }

                events.emit('verbose', 'Found extra default icon: ' + JSON.stringify(found) + ' and ignoring in favor of ' + JSON.stringify(favor) + '.');
            } else {
                default_icon = icon;
            }
        } else {
            parseIcon(icon, size);
        }
    }

    return {
        android_icons,
        default_icon
    };
}

function cleanIcons (projectRoot, projectConfig, platformResourcesDir) {
    const icons = projectConfig.getIcons('android');

    // Skip if there are no app defined icons in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    const resourceMap = Object.assign(
        {},
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher.png'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_foreground.png'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_background.png'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_monochrome.png'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_foreground.xml'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_background.xml'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher_monochrome.xml'),
        mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'ic_launcher.xml')
    );

    events.emit('verbose', 'Cleaning icons at ' + platformResourcesDir);

    // No source paths are specified in the map, so updatePaths() will delete the target files.
    FileUpdater.updatePaths(resourceMap, { rootDir: projectRoot, all: true }, logFileOp);
}

/**
 * Gets a map containing resources of a specified name from all drawable folders in a directory.
 */
function mapImageResources (rootDir, subDir, type, resourceName) {
    const pathMap = {};
    const globOptions = { cwd: path.join(rootDir, subDir), onlyDirectories: true };
    glob.sync(type + '-*', globOptions).forEach(drawableFolder => {
        const imagePath = path.join(subDir, drawableFolder, resourceName);
        pathMap[imagePath] = null;
    });
    return pathMap;
}

function updateFileResources (cordovaProject, platformDir) {
    const files = cordovaProject.projectConfig.getFileResources('android');

    // if there are resource-file elements in config.xml
    if (files.length === 0) {
        events.emit('verbose', 'This app does not have additional resource files defined');
        return;
    }

    const resourceMap = {};
    files.forEach(function (res) {
        const targetPath = path.join(platformDir, res.target);
        resourceMap[targetPath] = res.src;
    });

    events.emit('verbose', 'Updating resource files at ' + platformDir);
    FileUpdater.updatePaths(
        resourceMap, { rootDir: cordovaProject.root }, logFileOp);
}

function cleanFileResources (projectRoot, projectConfig, platformDir) {
    const files = projectConfig.getFileResources('android', true);
    if (files.length > 0) {
        events.emit('verbose', 'Cleaning resource files at ' + platformDir);

        const resourceMap = {};
        files.forEach(function (res) {
            const filePath = path.join(platformDir, res.target);
            resourceMap[filePath] = null;
        });

        FileUpdater.updatePaths(
            resourceMap, { rootDir: projectRoot, all: true }, logFileOp);
    }
}

/**
 * Gets and validates 'AndroidLaunchMode' prepference from config.xml. Returns
 *   preference value and warns if it doesn't seems to be valid
 *
 * @param   {ConfigParser}  platformConfig  A configParser instance for
 *   platform.
 *
 * @return  {String}                  Preference's value from config.xml or
 *   default value, if there is no such preference. The default value is
 *   'singleTop'
 */
function findAndroidLaunchModePreference (platformConfig) {
    const launchMode = platformConfig.getPreference('AndroidLaunchMode');
    if (!launchMode) {
        // Return a default value
        return 'singleTop';
    }

    const expectedValues = ['standard', 'singleTop', 'singleTask', 'singleInstance'];
    const valid = expectedValues.indexOf(launchMode) >= 0;
    if (!valid) {
        // Note: warn, but leave the launch mode as developer wanted, in case the list of options changes in the future
        events.emit('warn', 'Unrecognized value for AndroidLaunchMode preference: ' +
            launchMode + '. Expected values are: ' + expectedValues.join(', '));
    }

    return launchMode;
}
