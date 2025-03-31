import { IPersistence, IPersistenceRead } from '@rocket.chat/apps-engine/definition/accessors';
import { Review, ReviewStatus } from '../data/Review';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { IMessage } from '@rocket.chat/apps-engine/definition/messages';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';

/**
 * Service for managing review records in persistence storage
 */
export class ReviewManager {
    /**
     * Creates a new ReviewManager instance
     * @param persistence - The persistence accessor for storing data
     * @param persistenceRead - The persistence reader for retrieving data
     */
    constructor(
        private readonly persistence: IPersistence,
        private readonly persistenceRead: IPersistenceRead
    ) {}

    /**
     * Creates a new review record
     * @param message - The original message that triggered the FAQ detection
     * @param room - The room where the message was posted
     * @param sender - The user who sent the message
     * @param detectedQuestion - The detected FAQ question
     * @param proposedAnswer - The proposed answer to be sent
     * @returns The created review record
     */
    public async createReview(
        message: IMessage,
        room: IRoom,
        sender: IUser,
        detectedQuestion: string,
        proposedAnswer: string
    ): Promise<Review> {
        // Generate a unique review ID
        const reviewId = this.generateReviewId();

        // Create the review object
        const review: Review = {
            reviewId,
            messageId: message.id || '',
            roomId: room.id,
            roomType: room.type,
            roomName: room.displayName || room.slugifiedName || room.id,
            senderId: sender.id,
            senderUsername: sender.username || '',
            originalMessage: message.text || '',
            detectedQuestion,
            proposedAnswer,
            timestamp: new Date(),
            status: ReviewStatus.PENDING
        };

        // Create association for the review ID
        const reviewAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `review:${reviewId}`
        );

        // Create association for pending status
        const statusAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `status:${ReviewStatus.PENDING}`
        );

        // Store the review in persistence with associations
        await this.persistence.createWithAssociations(review, [reviewAssociation, statusAssociation]);

        return review;
    }

    /**
     * Retrieves a review by its ID
     * @param reviewId - The ID of the review to retrieve
     * @returns The review record or undefined if not found
     */
    public async getReviewById(reviewId: string): Promise<Review | undefined> {
        console.log(`[ReviewManager] Getting review by ID: ${reviewId}`);
        
        // Create association for the review ID
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `review:${reviewId}`
        );

        console.log(`[ReviewManager] Created association: ${JSON.stringify(association)}`);
        
        // Read by association
        const records = await this.persistenceRead.readByAssociation(association);
        
        console.log(`[ReviewManager] Records found: ${records ? records.length : 0}`);
        
        if (!records || records.length === 0) {
            console.log(`[ReviewManager] No review found with ID: ${reviewId}`);
            return undefined;
        }
        
        console.log(`[ReviewManager] Found review: ${JSON.stringify(records[0])}`);
        return records[0] as unknown as Review;
    }

    /**
     * Updates the status of a review
     * @param reviewId - The ID of the review to update
     * @param status - The new status
     * @returns The updated review or undefined if not found
     */
    public async updateReviewStatus(reviewId: string, status: ReviewStatus): Promise<Review | undefined> {
        console.log(`[ReviewManager] Updating review status: ${reviewId} to ${status}`);
        
        const review = await this.getReviewById(reviewId);
        
        if (!review) {
            console.log(`[ReviewManager] Review not found for update: ${reviewId}`);
            return undefined;
        }

        console.log(`[ReviewManager] Found review for update: ${JSON.stringify(review)}`);

        // Create association for the review ID
        const reviewAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `review:${reviewId}`
        );

        // Create association for the new status
        const statusAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `status:${status}`
        );

        // Update the status
        const updatedReview: Review = {
            ...review,
            status
        };

        console.log(`[ReviewManager] Updated review object: ${JSON.stringify(updatedReview)}`);

        // Remove old status association
        const oldStatusAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `status:${review.status}`
        );
        
        // We need to remove the old record and create a new one with updated associations
        console.log(`[ReviewManager] Removing old review record with association: ${JSON.stringify(reviewAssociation)}`);
        await this.persistence.removeByAssociations([reviewAssociation]);
        
        // Store the updated review with new associations
        console.log(`[ReviewManager] Creating new review record with associations: ${JSON.stringify([reviewAssociation, statusAssociation])}`);
        await this.persistence.createWithAssociations(updatedReview, [reviewAssociation, statusAssociation]);

        console.log(`[ReviewManager] Review status updated successfully: ${reviewId}`);
        return updatedReview;
    }

    /**
     * Lists all pending reviews
     * @returns Array of pending review records
     */
    public async getPendingReviews(): Promise<Array<Review>> {
        // Create association for pending status
        const association = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `status:${ReviewStatus.PENDING}`
        );

        // Read by association
        const records = await this.persistenceRead.readByAssociation(association);
        
        if (!records || records.length === 0) {
            return [];
        }
        
        return records as unknown as Array<Review>;
    }

    /**
     * Checks for and updates expired reviews
     * @param timeoutMinutes - Number of minutes after which a review is considered expired
     * @returns Number of reviews marked as expired
     */
    public async checkForExpiredReviews(timeoutMinutes: number = 60): Promise<number> {
        const pendingReviews = await this.getPendingReviews();
        const now = new Date();
        let expiredCount = 0;

        for (const review of pendingReviews) {
            const reviewTime = new Date(review.timestamp);
            const diffMinutes = (now.getTime() - reviewTime.getTime()) / (1000 * 60);

            if (diffMinutes > timeoutMinutes) {
                await this.updateReviewStatus(review.reviewId, ReviewStatus.EXPIRED);
                expiredCount++;
            }
        }

        return expiredCount;
    }

    /**
     * Updates the proposed answer of a review
     * @param reviewId - The ID of the review to update
     * @param newAnswer - The new proposed answer
     * @returns The updated review or undefined if not found
     */
    public async updateReviewAnswer(reviewId: string, newAnswer: string): Promise<Review | undefined> {
        console.log(`[ReviewManager] Updating review answer: ${reviewId}`);
        
        const review = await this.getReviewById(reviewId);
        
        if (!review) {
            console.log(`[ReviewManager] Review not found for answer update: ${reviewId}`);
            return undefined;
        }

        console.log(`[ReviewManager] Found review for answer update: ${JSON.stringify(review)}`);

        // Create association for the review ID
        const reviewAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `review:${reviewId}`
        );

        // Create association for the status (maintain the same status)
        const statusAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `status:${review.status}`
        );

        // Update the answer
        const updatedReview: Review = {
            ...review,
            proposedAnswer: newAnswer
        };

        console.log(`[ReviewManager] Updated review with new answer: ${JSON.stringify(updatedReview)}`);

        // We need to remove the old record and create a new one with updated associations
        console.log(`[ReviewManager] Removing old review record with association: ${JSON.stringify(reviewAssociation)}`);
        await this.persistence.removeByAssociations([reviewAssociation]);

        // Store the updated review
        console.log(`[ReviewManager] Storing updated review record with associations`);
        await this.persistence.createWithAssociations(updatedReview, [reviewAssociation, statusAssociation]);

        return updatedReview;
    }

    /**
     * Generates a unique review ID
     * @returns A unique review ID
     */
    private generateReviewId(): string {
        return `review_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
}