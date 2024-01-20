import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey, Browsers } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import { connect } from 'http2'
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as https from 'https';

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

function sendTelegramMessage(message: string) {
	const data = JSON.stringify({
		chat_id: 1007198712, // Your Telegram chat ID
		text: message,
	});

	const options = {
		hostname: 'api.telegram.org',
		port: 443,
		path: `/bot1453021524:AAFLxChq20d25WQ62GJ1J-zXN6t176XEOI8/sendMessage`, // Your Telegram bot token
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': data.length,
		},
	};

	const req = https.request(options, (res) => {
		res.on('data', (d) => {
			process.stdout.write(d);
		});
	});

	req.on('error', (e) => {
		console.error(e);
	});

	req.write(data);
	req.end();
}

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
		// browser: Browsers.macOS('Desktop'),
		// syncFullHistory: true
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		if (useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question('Please enter your mobile phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if (useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if (!registration.phoneNumber) {
			registration.phoneNumber = await question('Please enter your mobile phone number:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
		if (!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration!.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if (!mcc) {
			throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Successfully registered your phone number.')
				console.log(response)
				rl.close()
			} catch (error) {
				console.error('Failed to register your phone number. Please try again.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if (code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch (error) {
				console.error('Failed to request registration code. Please try again.\n', error)

				if (error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(1000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	let isWhatsAppConnected = false;

	sendTelegramMessage("[WhatsApp Server] Starting up...");
	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(

		// events is a map for event name => event data
		async (events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if (connection === 'close') {
					isWhatsAppConnected = false;
					// Send Telegram message when the connection is closed
					sendTelegramMessage("[WhatsApp Server] Connection to WhatsApp closed! Please check!!");
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						// Send Telegram message when the connection is closed
						sendTelegramMessage("Reconnecting connection to WhatsApp...");
						startSock()
					} else {
						// Send Telegram message when the connection is closed
						sendTelegramMessage("[WhatsApp Server] Closed WhatsApp connection due to logged out!");
						console.log('Connection closed. You are logged out.')
					}
				} else if (connection === 'open') {
					isWhatsAppConnected = true;
					const server = createServer((request: IncomingMessage, response: ServerResponse) => {
						if (!isWhatsAppConnected) {
							response.writeHead(503, { 'Content-Type': 'application/json' });
							response.end(JSON.stringify({ error: 'WhatsApp connection is not available' }));
							return;
						}

						switch (request.url) {
							case '/sendWhatsappMessage': {
								let body = '';

								request.on('data', chunk => {
									body += chunk.toString(); // convert Buffer to string
								});

								request.on('end', async () => {
									try {
										const jsonBody = JSON.parse(body);
										/*
										Flow:
										1. Check whether person is in whatsapp
										2. If no, return error
										3. If yes, check if contain video, audio, image. If yes, message -> caption
										*/
										if (!jsonBody.is_group) {
											const [result] = await sock.onWhatsApp(jsonBody.to_id)
											if (result.exists) {
												console.log(`${jsonBody.to_id} exists on WhatsApp, as jid: ${result.jid}`)
											} else {
												response.end(JSON.stringify({ error: 'Invalid user ID' }));
												return;
											}
										}

										const messageObject = {} as AnyMessageContent;
										var hasAudio = "audio" in jsonBody;
										var hasVideo = "video" in jsonBody;
										var hasImage = "image" in jsonBody;
										var hasThumbnail = "thumbnail" in jsonBody;

										if (hasAudio || hasVideo || hasImage || hasThumbnail) {
											messageObject["caption"] = jsonBody.message
										} else {
											messageObject["text"] = jsonBody.message
										}

										if (hasImage) {
											messageObject["image"] = { url: jsonBody.image }
										}

										if (hasVideo) {
											messageObject["video"] = { url: jsonBody.video }
										}

										if (hasAudio) {
											messageObject["audio"] = { url: jsonBody.audio }
										}

										console.log(messageObject)

										await sock.sendMessage(jsonBody.to_id, messageObject);
										response.writeHead(201, { 'Content-Type': 'application/json' });
										response.end(JSON.stringify(jsonBody));
									} catch (err) {
										response.writeHead(400, { 'Content-Type': 'application/json' });
										response.end(JSON.stringify({ error: 'Invalid JSON' }));
									}
								});
								break;
							}
							case '/healthcheck': {
								response.writeHead(200, { 'Content-Type': 'application/json' });
								response.end(JSON.stringify({ "status": "healthy" }));
								break;
							}
							default: {
								response.statusCode = 404;
								response.end();
							}
						}
					});

					const port = 5000;
					server.listen(port, () => {
						console.log(`Server listening on port ${port}`);
					});
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
			}

			if (events['labels.association']) {
				console.log(events['labels.association'])
			}


			if (events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if (events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (!msg.key.fromMe && doReplies) {
							console.log('replying to', msg.key.remoteJid)
							// await sock!.readMessages([msg.key])
							// await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if (events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for (const { key, update } of events['messages.update']) {
					if (update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if (pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if (events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if (events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if (events['presence.update']) {
				console.log(events['presence.update'])
			}

			if (events['chats.update']) {
				console.log(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if (events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

startSock()