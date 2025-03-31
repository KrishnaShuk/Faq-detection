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
            ),
        ]);
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
                config.similarityThreshold || 0.7,
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
        if (config.faqLogChannel) {
            try {
                // Get or create the log channel
                const appUser = await read.getUserReader().getAppUser();
                if (!appUser) {
                    this.getLogger().error('Could not get app user for logging');
                    return;
                }
                
                const logChannel = await channelService.getOrCreateLogChannel(
                    appUser,
                    config.faqLogChannel
                );
                
                // Log the message
                await channelService.logMessage(
                    logChannel,
                    MessageType.ALPHA,
                    classification.message,
                    message.sender,
                    message.room,
                    {
                        score: classification.score,
                        matchedQuestion: classification.matchedFaq.question,
                        proposedAnswer: answer
                    }
                );
                
                this.getLogger().debug('Alpha message logged to channel');
            } catch (error) {
                this.getLogger().error('Error logging Alpha message to channel:', error);
            }
        }
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
                if (config.faqLogChannel) {
                    try {
                        // Get or create the log channel
                        const appUser = await read.getUserReader().getAppUser();
                        if (!appUser) {
                            this.getLogger().error('Could not get app user for logging');
                            return;
                        }
                        
                        const logChannel = await channelService.getOrCreateLogChannel(
                            appUser,
                            config.faqLogChannel
                        );
                        
                        // Log the message
                        await channelService.logMessage(
                            logChannel,
                            MessageType.BETA,
                            classification.message,
                            message.sender,
                            message.room,
                            {
                                score: classification.score,
                                matchedQuestion: llmResult.detectedQuestion,
                                proposedAnswer: llmResult.answer,
                                reviewId: review.reviewId
                            },
                            reviewer // Pass the reviewer to the logMessage method
                        );
                        
                        this.getLogger().debug('Beta message logged to channel');
                    } catch (error) {
                        this.getLogger().error('Error logging Beta message to channel:', error);
                    }
                }
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
        
        // Get the review ID from the action ID mapping
        let reviewId: string | undefined;
        
        if (actionId.startsWith('approve_') || actionId.startsWith('reject_') || 
            actionId.startsWith('edit_') || actionId.startsWith('submit_edit_') || 
            actionId.startsWith('cancel_edit_') || actionId.startsWith('confirm_edit_')) {
            // Extract reviewId from the actionId
            const parts = actionId.split('_');
            if (parts.length > 1) {
                reviewId = parts[parts.length - 1];
                // Also store it in the map for future reference
                this.reviewActions.set(actionId, reviewId);
            }
        } else {
            reviewId = this.reviewActions.get(actionId);
        }
        
        if (!reviewId) {
            this.getLogger().error(`No review ID found for action: ${actionId}`);
            return context.getInteractionResponder().successResponse();
        }
        
        // Get the review manager
        const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
        
        // Get the review
        const review = await reviewManager.getReviewById(reviewId);
        if (!review) {
            this.getLogger().error(`Review not found: ${reviewId}`);
            return context.getInteractionResponder().successResponse();
        }
        
        // Get the notification service
        const notificationService = new NotificationService(read, modify);
        
        // Handle different actions
        if (actionId.startsWith('approve_')) {
            // Handle approve action
            const handler = new ApproveActionHandler(read, persistence, modify, this.getLogger());
            await handler.handleApproveAction(reviewId, user);
            
            // Update log channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return context.getInteractionResponder().successResponse();
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'approved',
                        user
                    );
                } catch (error) {
                    this.getLogger().error('Error updating log channel:', error);
                }
            }
        } else if (actionId.startsWith('reject_')) {
            // Handle reject action
            const handler = new RejectActionHandler(read, persistence, modify, this.getLogger());
            await handler.handleRejectAction(reviewId, user);
            
            // Update log channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return context.getInteractionResponder().successResponse();
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'rejected',
                        user
                    );
                } catch (error) {
                    this.getLogger().error('Error updating log channel:', error);
                }
            }
        } else if (actionId.startsWith('edit_')) {
            // Handle edit action
            const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
            await handler.handleEditAction(reviewId, user, triggerId);
            
            // Update log channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return context.getInteractionResponder().successResponse();
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'editing',
                        user
                    );
                } catch (error) {
                    this.getLogger().error('Error updating log channel:', error);
                }
            }
        } else if (actionId.startsWith('submit_edit_')) {
            // Handle submit edit action
            const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
            await handler.handleSubmitEdit(reviewId, user);
            
            // Update log channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return context.getInteractionResponder().successResponse();
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'edited',
                        user
                    );
                } catch (error) {
                    this.getLogger().error('Error updating log channel:', error);
                }
            }
        } else if (actionId.startsWith('cancel_edit_')) {
            // Handle cancel edit action
            const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
            await handler.handleCancelEdit(reviewId, user);
            
            // Update log channel if enabled
            const config = await getAPIConfig(read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(read, modify, this.getLogger());
                    const appUser = await read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.getLogger().error('Could not get app user for logging');
                        return context.getInteractionResponder().successResponse();
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'pending',
                        user
                    );
                } catch (error) {
                    this.getLogger().error('Error updating log channel:', error);
                }
            }
        }
        
        return context.getInteractionResponder().successResponse();
    }

    /**
     * Handles modal submit interactions
     */
    async executeViewSubmitHandler(
        context: UIKitViewSubmitInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const { view, user } = context.getInteractionData();
        this.getLogger().debug(`Modal submitted: ${view.id} by user: ${user.id}`);
        
        // Check if this is an edit modal
        if (view.id.startsWith('edit_modal_')) {
            // Extract review ID from the modal ID
            const reviewId = view.id.replace('edit_modal_', '');
            
            // Get the edited answer from the input
            // Use type assertion to access the state values
            const state = view.state as any;
            const editedAnswer = state && state.edit_answer_block ? 
                state.edit_answer_block.edit_answer_input : undefined;
            
            if (!editedAnswer) {
                this.getLogger().error(`No edited answer found in modal submission`);
                return context.getInteractionResponder().successResponse();
            }
            
            // Process the edited answer
            try {
                const handler = new EditActionHandler(read, persistence, modify, this.getLogger());
                await handler.handleSubmitEdit(reviewId, user, editedAnswer);
                
                return context.getInteractionResponder().successResponse();
            } catch (error) {
                this.getLogger().error(`Error processing edited answer: ${error}`);
                return context.getInteractionResponder().errorResponse();
            }
        }
        
        return context.getInteractionResponder().successResponse();
    }

    // Required by IUIKitInteractionHandler but not used in this app
    async executeBlockActionHandler(
        context: UIKitBlockInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        return context.getInteractionResponder().successResponse();
    }

    // Required by IUIKitInteractionHandler but not used in this app
    async executeViewClosedHandler(
        context: UIKitViewCloseInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        return context.getInteractionResponder().successResponse();
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