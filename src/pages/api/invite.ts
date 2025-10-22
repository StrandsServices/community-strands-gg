import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url, request }) => {
  const runtime = locals.runtime;
  const DISCORD_BOT_TOKEN = runtime?.env?.DISCORD_BOT_TOKEN;
  const DISCORD_CHANNEL_ID = runtime?.env?.DISCORD_CHANNEL_ID;
  const KV = runtime?.env?.DISCORD_INVITES;

  // CORS check - only allow requests from same origin
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const allowedOrigin = url.origin;

  // Block requests that have an origin/referer from a different domain
  if ((origin && origin !== allowedOrigin) || (referer && !referer.startsWith(allowedOrigin))) {
    console.warn('CORS violation detected', { origin, referer, allowedOrigin });
    return new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
    return new Response(
      JSON.stringify({ error: 'Missing Discord bot configuration' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Honeypot check - bots will fill this field
  const honeypot = url.searchParams.get('email');
  if (honeypot) {
    console.warn('Honeypot triggered - potential bot detected', { honeypot });
    return new Response(
      JSON.stringify({ error: 'Invalid request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check User-Agent - block obvious bots
  const userAgent = request.headers.get('User-Agent') || '';
  const botPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /curl/i,
    /wget/i,
    /python/i,
    /go-http/i,
    /java/i,
  ];

  if (botPatterns.some(pattern => pattern.test(userAgent))) {
    console.warn('Bot User-Agent detected', { userAgent });
    return new Response(
      JSON.stringify({ error: 'Invalid request' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const now = Date.now();

  // Check if UUID was passed from client
  const clientUuid = url.searchParams.get('uuid');
  let uuid = clientUuid;

  // If UUID provided, check KV for existing invite
  if (uuid && KV) {
    try {
      const kvKey = `discord:invite:${uuid}`;
      const cachedData = await KV.get(kvKey, 'json');

      if (cachedData) {
        const cachedInvite = cachedData as { uuid: string; code: string; expiresAt: number; createdAt: number };

        // Check if invite is still valid with a 10 second buffer
        const timeRemaining = cachedInvite.expiresAt - now;
        const isValid = timeRemaining > 10000; // Must have more than 10 seconds remaining

        if (isValid) {
          console.log(`Returning existing invite for UUID ${uuid}: ${cachedInvite.code}, expires at: ${new Date(cachedInvite.expiresAt).toISOString()}, ${Math.floor(timeRemaining / 1000)}s remaining`);
          return new Response(
            JSON.stringify({
              uuid: cachedInvite.uuid,
              code: cachedInvite.code,
              expiresAt: cachedInvite.expiresAt,
              cached: true,
              serverTime: now // Include server timestamp for debugging
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        } else {
          console.log(`Invite for UUID ${uuid} has expired or expiring soon (${Math.floor(timeRemaining / 1000)}s remaining), generating new one`);
          // Delete expired invite from KV
          try {
            await KV.delete(kvKey);
            console.log(`Deleted expired invite from KV: ${kvKey}`);
          } catch (e) {
            console.error('Failed to delete expired invite:', e);
          }
        }
      }
    } catch (error) {
      console.error('KV lookup error:', error);
    }
  }

  // Generate new UUID if not provided or invite expired
  if (!uuid) {
    uuid = crypto.randomUUID();
  }

  // Generate a new invite link
  try {
    console.log('Generating new Discord invite link...');

    const response = await fetch(
      `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/invites`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_age: 120, // 2 minutes
          max_uses: 1, // single use
          temporary: false,
          unique: true, // Always create unique invite
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Discord API error:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to generate invite', details: error }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data: { code: string } = await response.json();
    const expiresAt = now + (120 * 1000); // Current time + 2 minutes

    if(!data.code) {
      console.error('Discord API did not return an invite code:', data);
      return new Response(
        JSON.stringify({ error: 'Invalid response from Discord API' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const inviteData = {
      uuid,
      code: data.code,
      expiresAt,
      createdAt: now,
    };

    // Store the invite in KV with UUID as key and TTL
    if (KV) {
      try {
        const ttlSeconds = Math.floor((expiresAt - now) / 1000); // Convert to seconds
        const kvKey = `discord:invite:${uuid}`;
        await KV.put(kvKey, JSON.stringify(inviteData), { expirationTtl: ttlSeconds });
        console.log(`Stored invite ${uuid} in KV with ${ttlSeconds}s TTL`);
      } catch (error) {
        console.error('Failed to store invite in KV:', error);
      }
    }

    console.log(`Generated new single-use invite: ${data.code} (UUID: ${uuid}), expires at: ${new Date(expiresAt).toISOString()}`);

    return new Response(
      JSON.stringify({
        uuid,
        code: data.code,
        expiresAt,
        cached: false,
        serverTime: now // Include server timestamp for debugging
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error generating invite:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
