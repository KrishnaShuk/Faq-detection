import {
    ISetting,
    SettingType,
} from "@rocket.chat/apps-engine/definition/settings";
import { IRead } from '@rocket.chat/apps-engine/definition/accessors';

export enum Settings {
    MODEL_TYPE = 'model_type',
	API_KEY = 'api_key',
    API_ENDPOINT = 'api_endpoint',
    REVIEWER_USERNAMES = 'reviewer_usernames',
    ENABLE_REVIEW_MODE = 'enable_review_mode',
    SIMILARITY_THRESHOLD = 'similarity_threshold',
    FAQ_LOG_CHANNEL = 'faq_log_channel'
}

export const settings: ISetting[] = [
    {
        id: Settings.MODEL_TYPE,
        type: SettingType.SELECT,
        i18nLabel: "Model selection",
        i18nDescription: "AI model to use for inference.",
        values: [
            { key: "meta-llama/Llama-3.2-11B-Vision-Instruct", i18nLabel: "Llama 3.2 Vision 11B" }
        ],
        required: true,
        public: true,
        packageValue: "meta-llama/Llama-3.2-11B-Vision-Instruct",
    },
    {
		id: Settings.API_KEY,
		type: SettingType.PASSWORD,
        i18nLabel: 'API Key',
        i18nDescription: "API Key to access the LLM Model",
		i18nPlaceholder: '',
		required: true,
		public: false,
        packageValue: '',
	},
    {
        id: Settings.API_ENDPOINT,
        type: SettingType.STRING,
        i18nLabel: "API Endpoint",
        i18nDescription: "API endpoint to use for inference.",
        required: true,
        public: true,
        packageValue: '',
    },
    {
        id: Settings.REVIEWER_USERNAMES,
        type: SettingType.STRING,
        i18nLabel: "Reviewer Usernames",
        i18nDescription: "Comma-separated list of usernames who will review and approve FAQ responses",
        required: true,
        public: true,
        packageValue: '',
    },
    {
        id: Settings.ENABLE_REVIEW_MODE,
        type: SettingType.BOOLEAN,
        i18nLabel: "Enable Review Mode",
        i18nDescription: "When enabled, FAQ responses will be sent to the reviewers for approval before being sent to the channel",
        required: true,
        public: true,
        packageValue: true,
    },
    {
        id: Settings.SIMILARITY_THRESHOLD,
        type: SettingType.NUMBER,
        i18nLabel: "Similarity Threshold",
        i18nDescription: "Threshold for direct FAQ matches (0.0-1.0). Higher values require closer matches for automatic responses.",
        required: true,
        public: true,
        packageValue: 0.99,
    },
    {
        id: Settings.FAQ_LOG_CHANNEL,
        type: SettingType.STRING,
        i18nLabel: "FAQ Log Channel",
        i18nDescription: "Name of the channel where FAQ detection activity will be logged",
        required: true,
        public: true,
        packageValue: 'faq-log',
    },
];

export async function getAPIConfig(read: IRead) {
    const envReader = read.getEnvironmentReader().getSettings();
    const reviewerUsernamesStr = await envReader.getValueById(Settings.REVIEWER_USERNAMES);
    const reviewerUsernames = reviewerUsernamesStr ? reviewerUsernamesStr.split(',').map(username => username.trim()) : [];
    
    // Get the similarity threshold and ensure it's a number
    const thresholdValue = await envReader.getValueById(Settings.SIMILARITY_THRESHOLD);
    const similarityThreshold = typeof thresholdValue === 'number' 
        ? thresholdValue 
        : typeof thresholdValue === 'string' 
            ? parseFloat(thresholdValue) 
            : 0.99;
    
    return {
        apiKey: await envReader.getValueById(Settings.API_KEY),
        modelType: await envReader.getValueById(Settings.MODEL_TYPE),
        apiEndpoint: await envReader.getValueById(Settings.API_ENDPOINT),
        reviewerUsernames,
        enableReviewMode: await envReader.getValueById(Settings.ENABLE_REVIEW_MODE),
        similarityThreshold,
        faqLogChannel: await envReader.getValueById(Settings.FAQ_LOG_CHANNEL) || 'faq-log',
        // Always enable round-robin for multiple reviewers
        roundRobinReviewers: reviewerUsernames.length > 1,
    };
}
