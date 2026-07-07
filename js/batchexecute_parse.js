/**
 * Google Maps Batchexecute Parser
 */

class BatchexecuteParser {

    /**
     * Entry point
     */
    static parse(rawText) {

        const jsonString = this.extractMainJson(rawText);

        const root = JSON.parse(jsonString);

        const payloadString = root?.[0]?.[2];

        if (typeof payloadString !== "string") {
            throw new Error("Payload review tidak ditemukan.");
        }

        const payload = JSON.parse(payloadString);

        return this.extractReviews(payload);

    }

    /**
     * Mengambil JSON utama dari response batchexecute
     */
    static extractMainJson(text) {

        text = text.trim();

        // Hilangkan header
        text = text.replace(/^\)\]\}'\s*/m, "");

        const match = text.match(/^(\d+)/);

        if (!match) {
            throw new Error("Panjang payload tidak ditemukan.");
        }

        const length = Number(match[1]);

        const start = match[0].length;

        return text.substr(start, length).trim();

    }

    /**
     * Mengambil array review
     */
    static extractReviews(payload) {

        const reviewArray = payload?.[2];

        if (!Array.isArray(reviewArray)) {
            throw new Error("Array review tidak ditemukan.");
        }

        return reviewArray
            .map(review => this.parseReview(review))
            .filter(Boolean);

    }

    /**
     * Parsing 1 review
     */
    static parseReview(review) {

        try {

            return {

                id: review?.[0]?.[0] ?? null,

                name: review?.[0]?.[1]?.[5]?.[0] ?? null,

                profileUrl: review?.[0]?.[1]?.[5]?.[2]?.[0] ?? null,

                avatar: review?.[0]?.[1]?.[5]?.[1] ?? null,

                contributorId: review?.[0]?.[1]?.[5]?.[3] ?? null,

                reviewCount: review?.[0]?.[1]?.[5]?.[5] ?? null,

                photoCount: review?.[0]?.[1]?.[5]?.[6] ?? null,

                date: review?.[0]?.[2] ?? null,

                rating: review?.[1]?.[0]?.[0] ?? null,

                language: review?.[1]?.[14]?.[0] ?? null,

                review: review?.[1]?.[15]?.[0]?.[0] ?? "",

                reviewLength: review?.[1]?.[15]?.[0]?.[2]?.[1] ?? null

            };

        }
        catch (e) {

            console.warn("Gagal parse review", e);

            return null;

        }

    }

}   