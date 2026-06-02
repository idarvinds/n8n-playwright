import { INodeType, INodeExecutionData, IExecuteFunctions, INodeTypeDescription, NodeOperationError } from 'n8n-workflow';
import { join, resolve } from 'path';
import { platform } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { getBrowserExecutablePath } from './utils';
import { handleOperation } from './operations';
import { runCustomScript } from './customScript';
import { IBrowserOptions, IBrowserSession, ISessionOptions } from './types';
import { installBrowser } from '../scripts/setup-browsers';
import { BrowserType } from './config';

/**
 * Creates a browser session — either a standard ephemeral session or a
 * persistent context session that reuses a profile directory on disk.
 *
 * Ephemeral:  browser.launch() → browser.newContext() → context.newPage()
 * Persistent: browserType.launchPersistentContext(dir, opts) → context.newPage()
 *             (launchPersistentContext returns a BrowserContext, not a Browser)
 */
async function launchBrowserSession(
    playwright: any,
    browserType: BrowserType,
    executablePath: string,
    browserOptions: IBrowserOptions,
    sessionOptions: ISessionOptions,
    node: ReturnType<IExecuteFunctions['getNode']>,
): Promise<IBrowserSession> {
    const launchArgs = {
        headless: browserOptions.headless !== false,
        slowMo: browserOptions.slowMo || 0,
        executablePath,
    };

    if (sessionOptions.usePersistentProfile) {
        const rawDir = sessionOptions.profileDirectory?.trim();
        if (!rawDir) {
            throw new NodeOperationError(
                node,
                'Profile Directory must not be empty when "Use Persistent Browser Profile" is enabled. ' +
                'Example path: /home/node/.n8n/playwright-profiles/default',
            );
        }

        const profileDir = resolve(rawDir);

        if (!existsSync(profileDir)) {
            if (sessionOptions.createDirectoryIfMissing !== false) {
                mkdirSync(profileDir, { recursive: true });
            } else {
                throw new NodeOperationError(
                    node,
                    `Profile directory does not exist: ${profileDir}. ` +
                    'Enable "Create Directory If Missing" or create it manually before running.',
                );
            }
        }

        // launchPersistentContext returns a BrowserContext directly (no separate Browser object).
        const context = await playwright[browserType].launchPersistentContext(profileDir, launchArgs);
        const pages = context.pages() as any[];
        const page = pages.length > 0 ? pages[0] : await context.newPage();

        return { browser: null, context, page, isPersistent: true };
    }

    const browser = await playwright[browserType].launch(launchArgs);
    const context = await browser.newContext();
    const page = await context.newPage();
    return { browser, context, page, isPersistent: false };
}

/**
 * Closes a browser session without deleting any profile data.
 * In persistent mode only the context is closed; the profile directory is untouched.
 */
async function closeBrowserSession(session: IBrowserSession): Promise<void> {
    if (session.isPersistent) {
        await session.context.close();
    } else {
        await session.browser.close();
    }
}

export class Playwright implements INodeType {
    description : INodeTypeDescription = {
    displayName: 'Playwright',
    name: 'playwright',
    icon: 'file:playwright.svg',
    group: ['automation'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Automate browser actions using Playwright',
    defaults: {
        name: 'Playwright',
    },
    inputs: ['main'],
    outputs: ['main'],

    properties: [
        {
            displayName: 'Operation',
            name: 'operation',
            type: 'options',
            noDataExpression: true,
            options: [
                {
                    name: 'Click Element',
                    value: 'clickElement',
                    description: 'Click on an element',
                    action: 'Click on an element',
                },
                {
                    name: 'Fill Form',
                    value: 'fillForm',
                    description: 'Fill a form field',
                    action: 'Fill a form field',
                },
                {
                    name: 'Get Text',
                    value: 'getText',
                    description: 'Get text from an element',
                    action: 'Get text from an element',
                },
                {
                    name: 'Navigate',
                    value: 'navigate',
                    description: 'Navigate to a URL',
                    action: 'Navigate to a URL',
                },
                {
                    name: 'Run Custom Script',
                    value: 'runCustomScript',
                    description: 'Execute custom JavaScript code with full Playwright API access',
                    action: 'Run custom java script code',
                },
                {
                    name: 'Take Screenshot',
                    value: 'takeScreenshot',
                    description: 'Take a screenshot of a webpage',
                    action: 'Take a screenshot of a webpage',
                }
            ],
            default: 'navigate',
        },

        {
            displayName: 'URL',
            name: 'url',
            type: 'string',
            default: '',
            placeholder: 'https://example.com',
            description: 'The URL to navigate to',
            displayOptions: {
                show: {
                    operation: ['navigate', 'takeScreenshot', 'getText', 'clickElement', 'fillForm'],
                },
            },
            required: true,
        },

        // Custom Script Code
        {
            displayName: 'Script Code',
            name: 'scriptCode',
            type: 'string',
            typeOptions: {
                editor: 'codeNodeEditor',
                editorLanguage: 'javaScript',
            },
            required: true,
            default: `// Navigate to a URL
await $page.goto('https://example.com');

// Get page title
const title = await $page.title();
console.log('Page title:', title);

// Take a screenshot
const screenshot = await $page.screenshot({ type: 'png' });

// Return results
return [{
    json: { 
        title,
        url: $page.url()
    },
    binary: {
        screenshot: await $helpers.prepareBinaryData(
            Buffer.from(screenshot),
            'screenshot.png',
            'image/png'
        )
    }
}];`,
            description: 'JavaScript code to execute with Playwright. Access $page, $browser, $playwright, and all n8n Code node variables.',
            noDataExpression: true,
            displayOptions: {
                show: {
                    operation: ['runCustomScript'],
                },
            },
        },

        {
            displayName: 'Use <code>$page</code>, <code>$browser</code>, or <code>$playwright</code> to access Playwright. <a target="_blank" href="https://docs.n8n.io/code-examples/methods-variables-reference/">Special vars/methods</a> are available. <br><br>Debug by using <code>console.log()</code> statements and viewing their output in the browser console.',
            name: 'notice',
            type: 'notice',
            displayOptions: {
                show: {
                    operation: ['runCustomScript'],
                },
            },
            default: '',
        },

        {
            displayName: 'Property Name',
            name: 'dataPropertyName',
            type: 'string',
            required: true,
            default: 'screenshot',
            description: 'Name of the binary property in which to store the screenshot data',
            displayOptions: {
                show: {
                    operation: ['takeScreenshot'],
                },
            },
        },
        
        // Selector Type
        {
            displayName: 'Selector Type',
            name: 'selectorType',
            type: 'options',
            options: [
                {
                    name: 'CSS Selector',
                    value: 'css',
                    description: 'Use CSS selector (e.g., #submit-button, .my-class)',
                },
                {
                    name: 'XPath',
                    value: 'xpath',
                    description: 'Use XPath expression (e.g., //button[@ID="submit"])',
                }
            ],
            default: 'css',
            description: 'Choose between CSS selector or XPath',
            displayOptions: {
                show: {
                    operation: ['getText', 'clickElement', 'fillForm'],
                },
            },
        },
        
        // CSS Selector field
        {
            displayName: 'CSS Selector',
            name: 'selector',
            type: 'string',
            default: '',
            placeholder: '#submit-button',
            description: 'CSS selector for the element (e.g., #ID, .class, button[type="submit"])',
            displayOptions: {
                show: {
                    operation: ['getText', 'clickElement', 'fillForm'],
                    selectorType: ['css'],
                },
            },
            required: true,
        },
        
        // XPath field
        {
            displayName: 'XPath',
            name: 'xpath',
            type: 'string',
            default: '',
            placeholder: '//button[@ID="submit"]',
            description: 'XPath expression for the element (e.g., //div[@class="content"], //button[text()="Click Me"])',
            displayOptions: {
                show: {
                    operation: ['getText', 'clickElement', 'fillForm'],
                    selectorType: ['xpath'],
                },
            },
            required: true,
        },
        
        {
            displayName: 'Value',
            name: 'value',
            type: 'string',
            default: '',
            description: 'Value to fill in the form field',
            displayOptions: {
                show: {
                    operation: ['fillForm'],
                },
            },
            required: true,
        },
        {
            displayName: 'Browser',
            name: 'browser',
            type: 'options',
            options: [
                {
                    name: 'Chromium',
                    value: 'chromium',
                },
                {
                    name: 'Firefox',
                    value: 'firefox',
                },
                {
                    name: 'Webkit',
                    value: 'webkit',
                },
            ],
            default: 'chromium',
        },
        {
            displayName: 'Browser Launch Options',
            name: 'browserOptions',
            type: 'collection',
            placeholder: 'Add Option',
            default: {},
            options: [
                {
                    displayName: 'Headless',
                    name: 'headless',
                    type: 'boolean',
                    default: true,
                    description: 'Whether to run browser in headless mode',
                },
                {
                    displayName: 'Slow Motion',
                    name: 'slowMo',
                    type: 'number',
                    default: 0,
                    description: 'Slows down operations by the specified amount of milliseconds',
                }
            ],
        },
        {
            displayName: 'Screenshot Options',
            name: 'screenshotOptions',
            type: 'collection',
            placeholder: 'Add Option',
            default: {},
            displayOptions: {
                show: {
                    operation: ['takeScreenshot'],
                },
            },
            options: [
                {
                    displayName: 'Full Page',
                    name: 'fullPage',
                    type: 'boolean',
                    default: false,
                    description: 'Whether to take a screenshot of the full scrollable page',
                },
                {
                    displayName: 'Path',
                    name: 'path',
                    type: 'string',
                    default: '',
                    description: 'The file path to save the screenshot to',
                },
            ],
        },
        {
            displayName: 'Session',
            name: 'sessionOptions',
            type: 'collection',
            placeholder: 'Add Session Option',
            default: {},
            description: 'Configure browser session persistence to reuse cookies and login state across executions',
            options: [
                {
                    displayName: 'Use Persistent Browser Profile',
                    name: 'usePersistentProfile',
                    type: 'boolean',
                    default: false,
                    description: 'Whether to reuse a browser profile stored on disk. Allows session cookies and login state to persist between workflow runs. When disabled (default) a fresh ephemeral session is used every time.',
                },
                {
                    displayName: 'Profile Directory',
                    name: 'profileDirectory',
                    type: 'string',
                    default: '',
                    placeholder: '/home/node/.n8n/playwright-profiles/default',
                    description: 'Absolute path to the browser profile directory on the n8n host or container filesystem. In Docker, this must point to a mounted volume path. Example: /home/node/.n8n/playwright-profiles/default',
                },
                {
                    displayName: 'Create Directory If Missing',
                    name: 'createDirectoryIfMissing',
                    type: 'boolean',
                    default: true,
                    description: 'Whether to automatically create the profile directory if it does not exist. When disabled, the node will throw an error if the directory is missing.',
                },
            ],
        },
    ],
};

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];

        for (let i = 0; i < items.length; i++) {
            const operation = this.getNodeParameter('operation', i) as string;
            const browserType = this.getNodeParameter('browser', i) as BrowserType;
            const browserOptions = this.getNodeParameter('browserOptions', i) as IBrowserOptions;
            const sessionOptions = this.getNodeParameter('sessionOptions', i) as ISessionOptions;

            let session: IBrowserSession | undefined;

            try {
                const playwright = require('playwright');
                const browsersPath = join(__dirname, '..', 'browsers');

                // Get browser executable path
                let executablePath;
                try {
                    executablePath = getBrowserExecutablePath(browserType, browsersPath);
                } catch (error) {
                    console.error(`Browser path error: ${error.message}`);
                    await installBrowser(browserType);
                    executablePath = getBrowserExecutablePath(browserType, browsersPath);
                }

                console.log(`Launching browser from: ${executablePath}`);

                session = await launchBrowserSession(
                    playwright,
                    browserType,
                    executablePath,
                    browserOptions,
                    sessionOptions,
                    this.getNode(),
                );
                const { browser, context, page, isPersistent } = session;

                let result;

                if (operation === 'runCustomScript') {
                    console.log(`Processing ${i + 1} of ${items.length}: [runCustomScript] Custom Script`);
                    // In persistent mode browser is null; expose context as $browser so
                    // scripts can still call $browser.newPage() / $browser.pages() etc.
                    result = await runCustomScript(this, i, isPersistent ? context : browser, page, playwright);
                    await closeBrowserSession(session);
                    returnData.push(...result);
                } else {
                    const url = this.getNodeParameter('url', i) as string;
                    await page.goto(url);
                    result = await handleOperation(operation, page, this, i);
                    await closeBrowserSession(session);
                    returnData.push(result);
                }
            } catch (error) {
                // Ensure the session is cleaned up even on failure
                if (session) {
                    try { await closeBrowserSession(session); } catch { /* ignore cleanup errors */ }
                }
                console.error(`Browser launch error:`, error);
                if (this.continueOnFail()) {
                    returnData.push({
                        json: {
                            error: error.message,
                            browserType,
                            os: platform(),
                        },
                    });
                    continue;
                }
                throw error;
            }
        }

        return [returnData];
    }
}
