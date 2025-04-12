import {
    IAppAccessors,
    IConfigurationExtend,
    IHttp,
    ILogger,
    IMessageBuilder,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { IMessage, IPostMessageSent } from '@rocket.chat/apps-engine/definition/messages';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { 
    IUIKitInteractionHandler, 
    IUIKitResponse, 
    UIKitActionButtonInteractionContext, 
    UIKitViewSubmitInteractionContext,
    UIKitBlockInteractionContext,
    UIKitViewCloseInteractionContext
} from '@rocket.chat/apps-engine/definition/uikit';

import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { settings, getAPIConfig } from '../config/settings';
import { FAQ, faqs } from '../data/faqs';
import { LLMService } from '../services/llmService';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';
import { createHash } from 'crypto';
import { 
    MessageType, 
    ClassificationResult 
} from '../services/MessageClassifier';
import { BM25Service } from '../services/BM25Service';
import { MessageClassifier } from '../services/MessageClassifier';
import { ChannelService } from '../services/ChannelService';
import { 
    Review, 
    ReviewStatus 
} from '../data/Review';
import { ApproveActionHandler } from '../handlers/ApproveActionHandler';
import { RejectActionHandler } from '../handlers/RejectActionHandler';
import { EditActionHandler } from '../handlers/EditActionHandler';
import { ReviewDistributionService } from '../services/ReviewDistributionService';

export class FaqDetectionApp extends App implements IPostMessageSent, IUIKitInteractionHandler {
    // Track recently processed message IDs and content hashes to avoid duplicates
    private processedMessages: Set<string> = new Set();
    private processedContents: Map<string, number> = new Map();
    private processingLock: boolean = false;
    
    // Map to store review IDs by action IDs
    private reviewActions: Map<string, string> = new Map();
    
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
        logger.debug('FAQ Detection App initialized');
    }

    /**
     * Get the modify accessor from the current context
     * This method is deprecated and should not be used.
     * Instead, use the modify parameter passed to the handler methods.
     * @deprecated Use the modify parameter passed to the handler methods
     * @returns The modify accessor from the current context
     */
    public getModify(): IModify {
        // This is a workaround to avoid type errors
        // In practice, this method should not be called
        throw new Error('getModify is deprecated. Use the modify parameter passed to the handler methods.');
    }

    public async extendConfiguration(
        configuration: IConfigurationExtend
    ): Promise<void> {
        await Promise.all([
            ...settings.map((setting) =>
                configuration.settings.provideSetting(setting)
            )
        ]);
    }

    /**
     * Initialize the app
     * This is called when the app is loaded
     */
    public async initialize(
        configurationExtend: IConfigurationExtend
    ): Promise<void> {
        await this.extendConfiguration(configurationExtend);
        
        this.getLogger().debug('FAQ Detection App initialized');
    }

    /**
     * Check if a message should be processed for FAQ detection
     * This method implements the IPostMessageSent interface
     */
    async checkPostMessageSent(message: IMessage, read: IRead, http: IHttp): Promise<boolean> {
        // This is the interface method that must match IPostMessageSent
        return true; // Always return true to ensure executePostMessageSent is called
    }

    /**
     * Internal method to check if a message should be processed
     * This is the actual implementation with all required parameters
     */
    private async shouldProcessMessage(message: IMessage, read: IRead, http: IHttp, persistence: IPersistence, modify: IModify): Promise<boolean> {
        this.getLogger().debug('Message received, starting message processing check');
        
        // Skip messages from bots or the app itself
        if (message.sender && (message.sender.type === 'bot' || message.sender.id === 'app')) {
            this.getLogger().debug('Skipping bot or app message');
            
            // Log bot message drop to the channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return false;
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(appUser, config.faqLogChannel);
                    
                    if (logChannel) {
                        const messageBuilder = modify.getCreator().startMessage()
                            .setRoom(logChannel)
                            .setText(`🤖 Skipped bot message from ${message.sender.username}: "${message.text}"`);
                        
                        await modify.getCreator().finish(messageBuilder);
                        this.getLogger().debug('Bot message drop logged to channel');
                    }
                } catch (error) {
                    this.getLogger().error('Error logging bot message drop:', error);
                }
            }
            
            return false;
        }

        // Check if the message was sent by this app
        const appUser = await read.getUserReader().getAppUser();
        if (appUser && message.sender && message.sender.id === appUser.id) {
            this.getLogger().debug('Skipping message from this app');
            return false;
        }

        // Get message text
        const text = message.text || '';
        if (text.length === 0) {
            this.getLogger().debug('Skipping empty message');
            return false;
        }

        // Skip messages that start with our bot prefix
        if (text.startsWith('🤖 FAQ Bot:')) {
            this.getLogger().debug('Skipping message with bot prefix');
            return false;
        }

        // *** DUPLICATE DETECTION COMPLETELY DISABLED ***
        // We still record the messages for reference but will process all messages regardless
        const messageId = message.id || '';
        const contentHash = this.hashString(text);
        const uniqueId = `${messageId}:${contentHash}`;
        
        // Record the message but do not check if it's a duplicate
        this.processedMessages.add(uniqueId);
        this.processedContents.set(contentHash, Date.now());
        
        this.getLogger().debug(`Message passed all checks, will be processed: ${uniqueId} (DUPLICATE DETECTION DISABLED)`);
        return true;
    }

    async executePostMessageSent(message: IMessage, read: IRead, http: IHttp, persistence: IPersistence, modify: IModify): Promise<void> {
        try {
            // Set processing lock
            this.processingLock = true;
            
            // Check if the message should be processed
            if (!(await this.shouldProcessMessage(message, read, http, persistence, modify))) {
                this.processingLock = false;
                return;
            }
            
            // Get message text
            const text = message.text || '';
            const messageId = message.id || '';
            const contentHash = this.hashString(text);
            const uniqueId = `${messageId}:${contentHash}`;
            
            // Record message but don't check for duplicates (duplicate detection disabled)
            this.processedMessages.add(uniqueId);
            this.processedContents.set(contentHash, Date.now());
            
            // Keep the sets size manageable
            if (this.processedMessages.size > 100) {
                const iterator = this.processedMessages.values();
                this.processedMessages.delete(iterator.next().value);
            }
            
            this.getLogger().debug(`Processing message: ${uniqueId} (DUPLICATE DETECTION DISABLED)`);
            
            // Get API configuration
            const config = await getAPIConfig(read);
            this.getLogger().debug('API config retrieved:', config);
            
            // Check if API configuration is valid
            if (!config.apiKey || !config.apiEndpoint) {
                this.getLogger().error('API configuration is missing. Please configure API Key and API Endpoint in app settings.');
                this.processingLock = false;
                return;
            }
            
            // Initialize services
            const messageClassifier = new MessageClassifier(
                faqs,
                config.similarityThreshold || 0.99,
                this.getLogger()
            );
            
            const channelService = new ChannelService(
                read,
                modify,
                this.getLogger()
            );
            
            const reviewDistributionService = new ReviewDistributionService(
                read,
                persistence,
                read.getPersistenceReader(),
                this.getLogger()
            );
            
            const llmService = new LLMService(
                http, 
                config.apiKey, 
                config.apiEndpoint, 
                config.modelType
            );
            
            // Classify the message
            const classification = messageClassifier.classifyMessage(text);
            this.getLogger().debug(`Message classified as: ${classification.type} with score: ${classification.score}`);
            
            // Process based on classification
            switch (classification.type) {
                case MessageType.ALPHA:
                    // Direct match - respond immediately
                    await this.handleAlphaMessage(
                        message,
                        classification,
                        modify,
                        read,
                        config,
                        channelService
                    );
                    break;
                    
                case MessageType.BETA:
                    // Potential match - needs LLM processing
                    await this.handleBetaMessage(
                        message,
                        classification,
                        llmService,
                        read,
                        persistence,
                        modify,
                        config,
                        channelService,
                        reviewDistributionService
                    );
                    break;
                    
                case MessageType.UNRELATED:
                    // Not a question or unrelated - do nothing
                    this.getLogger().debug('Message classified as unrelated, no action taken');
                    break;
            }
            
        } catch (error) {
            this.getLogger().error('Error processing message:', error);
        } finally {
            // Release processing lock
            this.processingLock = false;
        }
    }

    /**
     * Handles Alpha messages (direct matches)
     */
    private async handleAlphaMessage(
        message: IMessage,
        classification: {
            type: MessageType,
            matchedFaq?: any,
            score: number,
            message: string
        },
        modify: IModify,
        read: IRead,
        config: any,
        channelService: ChannelService
    ): Promise<void> {
        this.getLogger().debug('Handling Alpha message (direct match)');
        
        if (!classification.matchedFaq) {
            this.getLogger().error('Alpha message has no matched FAQ');
            return;
        }
        
        // Get the answer from the matched FAQ
        const answer = classification.matchedFaq.answer;
        
        // Send the response
        await this.sendResponse(answer, message.room, modify);
        this.getLogger().debug('Alpha response sent successfully');
        
        // Log to FAQ channel if enabled
        await this.logToFaqChannel(
            message.text || '',  // Ensure we have a string, not undefined
            message.room, 
            message.sender, 
            MessageType.ALPHA, 
            read,
            modify,
            {
                score: classification.score,
                matchedQuestion: classification.matchedFaq.question,
                proposedAnswer: answer
            }
        );
    }

    /**
     * Handles Beta messages (potential matches requiring LLM and review)
     */
    private async handleBetaMessage(
        message: IMessage,
        classification: {
            type: MessageType,
            score: number,
            message: string
        },
        llmService: LLMService,
        read: IRead,
        persistence: IPersistence,
        modify: IModify,
        config: any,
        channelService: ChannelService,
        reviewDistributionService: ReviewDistributionService
    ): Promise<void> {
        this.getLogger().debug('Handling Beta message (needs LLM processing)');
        
        // Process with LLM
        const llmResult = await llmService.checkMessage(classification.message, faqs);
        this.getLogger().debug('LLM service result:', llmResult);
        
        // If LLM found a match, process it
        if (llmResult.matched && llmResult.answer) {
            this.getLogger().debug('LLM found a match, processing for review');
            
            // Check if review mode is enabled
            if (config.enableReviewMode && config.reviewerUsernames) {
                // Select a reviewer using round-robin
                let reviewer: IUser | undefined;
                
                // Always use round-robin for reviewer selection when multiple reviewers exist
                if (config.reviewerUsernames.length > 1) {
                    this.getLogger().debug('Using round-robin reviewer selection for multiple reviewers');
                    reviewer = await reviewDistributionService.selectNextReviewer(config.reviewerUsernames);
                } else {
                    // Use the only reviewer in the list
                    const username = config.reviewerUsernames[0];
                    this.getLogger().debug(`Using single reviewer: ${username}`);
                    reviewer = await read.getUserReader().getByUsername(username);
                }
                
                if (!reviewer) {
                    this.getLogger().error('No reviewer available');
                    return;
                }
                
                // Create review
                const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
                const notificationService = new NotificationService(read, modify);
                
                const review = await reviewManager.createReview(
                    message,
                    message.room,
                    message.sender,
                    llmResult.detectedQuestion || '',
                    llmResult.answer
                );
                
                // Store the review ID for action handling
                const approveActionId = `approve_${review.reviewId}`;
                const rejectActionId = `reject_${review.reviewId}`;
                const editActionId = `edit_${review.reviewId}`;
                
                this.reviewActions.set(approveActionId, review.reviewId);
                this.reviewActions.set(rejectActionId, review.reviewId);
                this.reviewActions.set(editActionId, review.reviewId);
                
                // Send notification to reviewer
                await notificationService.sendReviewNotification(review, reviewer);
                this.getLogger().debug(`Review notification sent to ${reviewer.username}`);
                
                // Log to FAQ channel if enabled
                await this.logToFaqChannel(message.text || '', message.room, message.sender, MessageType.BETA, read, modify, {
                    score: classification.score,
                    matchedQuestion: llmResult.detectedQuestion,
                    proposedAnswer: llmResult.answer,
                    reviewId: review.reviewId
                }, reviewer);
                
            } else {
                // Direct response mode (original behavior)
                this.getLogger().debug('Review mode disabled, sending direct response...');
                await this.sendResponse(llmResult.answer, message.room, modify);
                this.getLogger().debug('Response sent successfully');
            }
        } else {
            this.getLogger().debug('LLM found no match or no answer available');
            if (llmResult.error) {
                this.getLogger().error('Error from LLM service:', llmResult.error);
            }
        }
    }

    /**
     * Handles the review workflow when review mode is enabled
     */
    async handleReviewMode(
        message: IMessage, 
        detectedQuestion: string,
        proposedAnswer: string,
        reviewerUsernames: string[],
        read: IRead,
        persistence: IPersistence,
        modify: IModify
    ): Promise<void> {
        this.getLogger().debug('Handling review mode workflow');
        
        // Create review manager and notification service
        const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
        const notificationService = new NotificationService(read, modify);
        
        // Create a review record
        const review = await reviewManager.createReview(
            message,
            message.room,
            message.sender,
            detectedQuestion,
            proposedAnswer
        );
        
        this.getLogger().debug(`Review created with ID: ${review.reviewId}`);
        
        // Store the review ID for action handling
        const approveActionId = `approve_${review.reviewId}`;
        const rejectActionId = `reject_${review.reviewId}`;
        const editActionId = `edit_${review.reviewId}`;
        
        this.reviewActions.set(approveActionId, review.reviewId);
        this.reviewActions.set(rejectActionId, review.reviewId);
        this.reviewActions.set(editActionId, review.reviewId);
        
        // Send notification to the first reviewer
        // In the future, we could implement round-robin or load balancing
        const reviewerUsername = reviewerUsernames[0];
        const reviewer = await read.getUserReader().getByUsername(reviewerUsername);
        
        if (!reviewer) {
            this.getLogger().error(`Reviewer not found: ${reviewerUsername}`);
            return;
        }
        
        await notificationService.sendReviewNotification(review, reviewer);
        this.getLogger().debug(`Review notification sent to ${reviewerUsername}`);
    }

    /**
     * Handles UI action button interactions (approve/reject)
     * Note: This method is not being used for the current button implementation
     * as the buttons are implemented as block actions, not action buttons.
     * The executeBlockActionHandler method is used instead.
     */
    async executeActionButtonInteraction(
        context: UIKitActionButtonInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const { actionId, triggerId, user } = context.getInteractionData();
        this.getLogger().debug(`Action button clicked: ${actionId} by user: ${user.id}`);
        this.getLogger().debug(`Note: This method is not being used for the current button implementation.`);
        
        // Simply return success as we're handling buttons in executeBlockActionHandler
        return context.getInteractionResponder().successResponse();
    }

    /**
     * Handles block action interactions (button clicks in UI blocks)
     */
    async executeBlockActionHandler(
        context: UIKitBlockInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const { actionId, user } = context.getInteractionData();
        this.getLogger().debug(`Block action triggered: ${actionId} by user: ${user.id}`);
        
        try {
            // Enhanced logging for debugging
            this.getLogger().debug(`Action ID format: ${actionId}`);
            
            // Extract the action type from the actionId (first part before underscore)
            const actionType = actionId.split('_')[0];
            
            // Extract the reviewId from the value property, which should contain just the reviewId
            const { value } = context.getInteractionData();
            this.getLogger().debug(`Action value: ${value}`);
            
            if (!value) {
                throw new Error(`No review ID found in action value`);
            }
            
            const reviewId = value;
            this.getLogger().debug(`Using reviewId from value: ${reviewId}`);
            
            // Get the review manager
            const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
            
            // Debug log to check if reviewManager is initialized
            this.getLogger().debug(`Review manager initialized, looking for review: ${reviewId}`);
            
            // Get the review
            const review = await reviewManager.getReviewById(reviewId);
            
            // Debug log for review retrieval
            if (review) {
                this.getLogger().debug(`Review found: ${JSON.stringify({
                    id: review.reviewId,
                    status: review.status,
                    sender: review.senderUsername
                })}`);
            } else {
                this.getLogger().debug(`No review found with ID: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }
            
            switch (actionType) {
                case 'approve':
                    this.getLogger().debug(`Processing approve action for review: ${reviewId}`);
                    const handler = new ApproveActionHandler(read, persistence, modify, this.getLogger());
                    await handler.handleApproveAction(reviewId, user);
                    break;
                    
                case 'reject':
                    this.getLogger().debug(`Processing reject action for review: ${reviewId}`);
                    const rejectHandler = new RejectActionHandler(read, persistence, modify, this.getLogger());
                    await rejectHandler.handleRejectAction(reviewId, user);
                    break;
                    
                case 'edit':
                    this.getLogger().debug(`Processing edit action for review: ${reviewId}`);
                    // For edit, we need to get the triggerId from the context
                    const { triggerId } = context.getInteractionData();
                    const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                    await editHandler.handleEditAction(reviewId, user, triggerId);
                    break;
                    
                default:
                    this.getLogger().warn(`Unknown action type: ${actionType}`);
                    break;
            }
            
            return context.getInteractionResponder().successResponse();
        } catch (error) {
            this.getLogger().error(`Error handling block action: ${error.message}`);
            this.getLogger().error(`Stack trace: ${error.stack}`);
            return context.getInteractionResponder().errorResponse();
        }
    }

    async executeViewSubmitHandler(
        context: UIKitViewSubmitInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const { view, user } = context.getInteractionData();
        this.getLogger().debug(`Modal submitted: ${view.id} by user: ${user.id}`);
        
        try {
            // Check if this is an edit modal
            if (view.id && view.id.startsWith('edit_modal_')) {
                this.getLogger().debug(`Processing edit modal submission`);
                
                // Get the state from the view
                const state = view.state as any;
                this.getLogger().debug(`Modal state: ${JSON.stringify(state)}`);
                
                // Extract review ID and edited answer
                let reviewId: string | undefined;
                let editedAnswer: string | undefined;
                
                // Try to extract review ID from the modal ID first
                if (view.id) {
                    reviewId = view.id.replace('edit_modal_', '');
                    this.getLogger().debug(`Extracted review ID from modal ID: ${reviewId}`);
                }
                
                // Try to extract review ID from the hidden field
                if (state && state.values && state.values.review_id_block && 
                    state.values.review_id_block.review_id_input) {
                    const reviewIdFromField = state.values.review_id_block.review_id_input;
                    
                    // Check if the value is a string or an object with a value property
                    if (typeof reviewIdFromField === 'string') {
                        reviewId = reviewIdFromField;
                    } else if (reviewIdFromField && reviewIdFromField.value) {
                        reviewId = reviewIdFromField.value;
                    }
                    
                    this.getLogger().debug(`Extracted review ID from field: ${reviewId}`);
                }
                
                // Extract edited answer
                if (state && state.values && state.values.edit_answer_block && 
                    state.values.edit_answer_block.edit_answer_input) {
                    const answerField = state.values.edit_answer_block.edit_answer_input;
                    
                    // Check if the value is a string or an object with a value property
                    if (typeof answerField === 'string') {
                        editedAnswer = answerField;
                    } else if (answerField && answerField.value) {
                        editedAnswer = answerField.value;
                    }
                }
                
                if (!reviewId) {
                    this.getLogger().error(`No review ID found in modal submission`);
                    return context.getInteractionResponder().errorResponse();
                }
                
                if (!editedAnswer) {
                    this.getLogger().error(`No edited answer found in modal submission for review: ${reviewId}`);
                    return context.getInteractionResponder().errorResponse();
                }
                
                this.getLogger().debug(`Processing edit for review ${reviewId} with answer: ${editedAnswer.substring(0, 50)}...`);
                
                // Process the edited answer
                const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
                await handler.handleSubmitEdit(reviewId, user, editedAnswer);
                
                this.getLogger().debug(`Successfully processed edit submission for review: ${reviewId}`);
            }
            
            return context.getInteractionResponder().successResponse();
        } catch (error) {
            this.getLogger().error(`Error in view submit handler: ${error instanceof Error ? error.message : String(error)}`);
            this.getLogger().error(`Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            return context.getInteractionResponder().errorResponse();
        }
    }

    async executeViewClosedHandler(
        context: UIKitViewCloseInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        try {
            const { view, user, actionId } = context.getInteractionData();
            this.getLogger().debug(`Modal closed: ${view.id} by user: ${user.id} with action: ${actionId}`);
            
            // Check if this is an edit modal being cancelled
            if (view.id && view.id.startsWith('edit_modal_')) {
                try {
                    // Extract review ID from the modal ID
                    const reviewId = view.id.replace('edit_modal_', '');
                    this.getLogger().debug(`Edit modal cancelled for review: ${reviewId}`);
                    
                    // Handle the cancel action
                    const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
                    await handler.handleCancelEdit(reviewId, user);
                    
                    this.getLogger().debug(`Successfully processed cancel edit for review: ${reviewId}`);
                } catch (error) {
                    this.getLogger().error(`Error handling modal close: ${error instanceof Error ? error.message : String(error)}`);
                    this.getLogger().error(`Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
                }
            }
            
            return context.getInteractionResponder().successResponse();
        } catch (error) {
            this.getLogger().error(`Error in view closed handler: ${error instanceof Error ? error.message : String(error)}`);
            this.getLogger().error(`Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            return context.getInteractionResponder().successResponse(); // Still return success to close the modal
        }
    }

    /**
     * Logs a message to the FAQ log channel
     * This method should be called from handler methods that have access to the modify parameter
     * @param message - The message to log
     * @param room - The room where the original message was sent
     * @param sender - The user who sent the original message
     * @param type - The type of message (FAQ, BETA, etc.)
     * @param read - The read accessor
     * @param modify - The modify accessor
     * @param additionalInfo - Additional information to include in the log
     * @param reviewer - The reviewer assigned to the message (if any)
     */
    private async logToFaqChannel(
        message: string,
        room: IRoom,
        sender: IUser,
        type: MessageType,
        read: IRead,
        modify: IModify,
        additionalInfo?: any,
        reviewer?: IUser
    ): Promise<void> {
        try {
            const config = await getAPIConfig(read);
            
            if (!config.faqLogChannel) {
                this.getLogger().debug('FAQ log channel not configured, skipping logging');
                return;
            }
            
            // Get the app user for creating the channel if needed
            const appUser = await read.getUserReader().getAppUser();
            if (!appUser) {
                this.getLogger().error('Could not get app user for logging');
                return;
            }
            
            this.getLogger().debug(`Attempting to log to channel: ${config.faqLogChannel}`);
            
            // Create channel service
            const channelService = new ChannelService(
                read,
                modify,
                this.getLogger()
            );
            
            // Get or create the log channel
            const logChannel = await channelService.getOrCreateLogChannel(
                appUser,
                config.faqLogChannel
            );
            
            if (!logChannel) {
                this.getLogger().error(`Failed to get or create log channel: ${config.faqLogChannel}`);
                return;
            }
            
            this.getLogger().debug(`Successfully got log channel: ${logChannel.id}, logging message`);
            
            // Log the message
            await channelService.logMessage(
                logChannel,
                type,
                message,
                sender,
                room,
                additionalInfo,
                reviewer
            );
            
            this.getLogger().debug(`Successfully logged message to channel: ${logChannel.id}`);
        } catch (error) {
            this.getLogger().error(`Error logging to FAQ channel: ${error instanceof Error ? error.message : String(error)}`);
            this.getLogger().error(`Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
        }
    }

    // Simple string hashing function
    hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    async sendResponse(answer: string, room: any, modify: IModify): Promise<void> {
        const messageBuilder = modify
            .getCreator()
            .startMessage()
            .setRoom(room)
            .setText(`🤖 FAQ Bot: ${answer}`);

        await modify.getCreator().finish(messageBuilder);
    }
}