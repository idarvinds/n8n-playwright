
export interface IBrowserOptions {
    headless?: boolean;
    slowMo?: number;
}


export interface BrowserPaths {
    chromium: {
        windows: string[];
        linux: string[];
        darwin: string[];
    };
    firefox: {
        windows: string[];
        linux: string[];
        darwin: string[];
    };
    webkit: {
        windows: string[];
        linux: string[];
        darwin: string[];
    };
}

export interface IScreenshotOptions {
    fullPage?: boolean;
    path?: string;
}

export interface ISessionOptions {
    usePersistentProfile?: boolean;
    profileDirectory?: string;
    createDirectoryIfMissing?: boolean;
}

export interface IBrowserSession {
    /** Browser instance (ephemeral mode) or null (persistent context mode). */
    browser: any;
    context: any;
    page: any;
    isPersistent: boolean;
}
