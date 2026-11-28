/**
 * Checks the EC2 instance metadata service for a Spot interruption notice (AWS gives about two minutes' warning
 * before it reclaims a Spot instance). IMDSv2: a session token first, then the notice; 404 means no notice.
 * ARION_IMDS_URL overrides the metadata address (tests).
 */
export async function spotInterruptionNotice(
    base: string = process.env.ARION_IMDS_URL || "http://169.254.169.254",
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = 1000
): Promise<string | null> {
    try {
        const token = await fetchImpl(`${base}/latest/api/token`, {
            method: "PUT",
            headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!token.ok) return null;
        const notice = await fetchImpl(`${base}/latest/meta-data/spot/instance-action`, {
            headers: { "X-aws-ec2-metadata-token": await token.text() },
            signal: AbortSignal.timeout(timeoutMs)
        });
        return notice.status === 200 ? await notice.text() : null;
    } catch {
        return null; // not on EC2, or the metadata service did not answer
    }
}
