;(function(window) {
	'use strict'

	const fetchOptions = {
		credentials: 'include',
		mode: 'cors',
	}

	// credits to https://github.com/mgp25/Instagram-API/blob/master/src/Request.php#L377
	const headers = new Headers()
	headers.append('X-IG-App-ID', '567067343352427')
	headers.append('X-IG-Capabilities', '3brTBw==')
	headers.append('X-IG-Connection-Type', 'WIFI')
	headers.append('X-IG-Connection-Speed', '3700kbps')
	headers.append('X-IG-Bandwidth-Speed-KBPS', '-1.000')
	headers.append('X-IG-Bandwidth-TotalBytes-B', '0')
	headers.append('X-IG-Bandwidth-TotalTime-MS', '0')
	headers.append('X-FB-HTTP-Engine', 'Liger')
	headers.append('Accept', '*/*')
	headers.append('Accept-Language', 'en-US')
	headers.append('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')
	headers.append('Connection', 'keep-alive')

	function fetch(url, options) {
		const opts = fetchOptions
		opts.referrerPolicy = 'no-referrer' // we only want that when requesting the private API
		opts.headers = headers
		if (options !== undefined) Object.assign({}, fetchOptions, options) // eslint-disable-line

		return window
			.fetch(url, opts)
			.then(checkStatus)
			.then(toText)
			.then(fixMaxId)
			.then(parseJSON)
			.catch(console.error)
	}

	function checkStatus(response) {
		if (response.ok) return response

		const error = new Error(`HTTP Error ${response.statusText}`)
		error.status = response.statusText
		error.response = response
		throw error
	}

	function toText(response) {
		return response.text()
	}

	const fixMaxIdRegex = /"next_max_id": (\d+)/g
	function fixMaxId(response) {
		return response.replace(fixMaxIdRegex, '"next_max_id": "$1"')
	}

	function parseJSON(response) {
		return JSON.parse(response)
	}

	class Storage {
		//instance = undefined // @TODO: Only latest Chrome supports this

		static getInstance(storage) {
			if (this.instance === undefined) this.instance = new Storage(storage)
			return this.instance
		}

		constructor(storage) {
			if (Storage.instance !== undefined) return Storage.instance

			Storage.STORAGE = storage
		}

		promise(cb) {
			return new Promise((resolve, reject) => {
				if (chrome.storage[Storage.STORAGE] === undefined) return reject(new Error('Chrome storage not available'))

				try {
					return cb(resolve, reject)
				} catch (e) {
					return reject(e)
				}
			})
		}

		set(key, value) {
			return this.promise((resolve, reject) =>
				chrome.storage[Storage.STORAGE].set({ [key]: value }, data => Storage.check(data, resolve, reject))
			)
		}

		get(key, defaultValue) {
			return this.promise((resolve, reject) =>
				chrome.storage[Storage.STORAGE].get({ [key]: defaultValue }, data => Storage.check(data[key], resolve, reject))
			)
		}

		remove(key) {
			return this.promise((resolve, reject) => chrome.storage[Storage.STORAGE].remove(key, data => Storage.check(data, resolve, reject)))
		}

		static check(data, resolve, reject) {
			if (chrome.runtime.lastError) {
				console.error(chrome.runtime.lastError)
				return reject(chrome.runtime.lastError)
			}

			return resolve(data)
		}
	}

	window.IG_Storage = new Storage('local')

	function getCookies(wanted) {
		const cookies = document.cookie.split('; '),
			result = {}

		for (const i in cookies) {
			const cookie = cookies[i].split('='),
				index = wanted.indexOf(cookie[0])
			if (index !== -1) {
				result[wanted[index]] = cookie[1]
			}
		}

		return result
	}

	const API = 'https://i.instagram.com/api/v1/'
	const WEB_API = 'https://www.instagram.com/web/'

	const UID = getCookies(['ds_user_id']).ds_user_id,
		UUID = '' // 'android-' + SparkMD5.hash(document.getElementsByClassName('coreSpriteDesktopNavProfile')[0].href.split('/')[3]).slice(0, 16)

	/**
	 * 0 -> posts + set next max id -> max id -> posts + set next max id -> repeat from 1.
	 *
	 * @class Instagram
	 */
	class Instagram {
		constructor(endpoint) {
			this.endpoint = endpoint // e.g. liked
			this.action = endpoint.slice(0, -1) // e.g. like
			this.uid = UID
			this.uuid = UUID

			this.firstNextMaxId = undefined
			this.firstRun = true

			this.nextMaxId = null
			this.items = []

			this.start = this.start.bind(this)
			this.fetch = this.fetch.bind(this)
			this.storeNext = this.storeNext.bind(this)
			this.normalize = this.normalize.bind(this)
			this.storeData = this.storeData.bind(this)
		}

		start() {
			if (this.firstNextMaxId === undefined) {
				return window.IG_Storage.get(this.endpoint, { items: [], nextMaxId: '' }).then(data => {
					this.firstNextMaxId = data.nextMaxId
					this.items = data.items
					return data
				})
			}
			return Promise.resolve(this.items)
		}

		fetch() {
			if (this.nextMaxId === '') return Promise.resolve(this.items) // nothing more to fetch

			return fetch(`${API}feed/${this.endpoint}/?${this.nextMaxId ? `max_id=${this.nextMaxId}&` : ''}`) // maxId means "show everything before X"
				.then(this.storeNext)
				.then(this.normalize)
				.then(this.storeData)
		}

		storeNext(data) {
			console.log(data)
			this.nextMaxId = data.next_max_id !== undefined ? `${data.next_max_id}` : ''

			return data
		}

		normalize(data) {
			if (data.items !== undefined && data.items.length && data.items[0].media !== undefined) {
				// we need to normalize "saved"
				data.items = data.items.map(item => item.media)
			}
			return data
		}

		/**
		 * Compare the first `len` elements of the old item data set with the new data set
		 * To do this, we compare the last elem's id of the new data set with `len` elems of the old.
		 *
		 * @param 	{Object} 	data
		 * @return 	{Boolean} Whether the function found a matching item or not
		 */
		compareData(data) {
			if (data.items === undefined || !data.items.length) return true // prevent adding undefined or similar

			const items = data.items,
				len = items.length,
				lastId = items[len - 1].id,
				maxLen = Math.min(len, this.items.length) // don't exceed either array len
			let match = false
			for (let i = 0; i < maxLen; ++i) {
				if (lastId === this.items[i].id) {
					// next elements are older
					match = true
					items.push(...this.items.slice(i + 1))
					this.items = items
					break
				}
			}

			return match
		}

		storeData(data) {
			const match = this.compareData(data)

			// If this was first run and we found no matches that means our data is too old (e.g. items got removed by user, or a lot added)
			if (this.firstRun && !match && this.firstNextMaxId !== this.nextMaxId) {
				this.items = []
			}
			this.firstRun = false

			// Add (older) items
			if (!match) this.items.push(...data.items)

			window.IG_Storage.set(this.endpoint, { items: this.items, nextMaxId: this.nextMaxId })

			return this.items
		}

		remove(id) {
			const headers = new Headers(),
				cookies = getCookies(['csrftoken'])
			headers.append('x-csrftoken', cookies.csrftoken)
			headers.append('x-instagram-ajax', '1')
			headers.append('x-requested-with', 'XMLHttpRequest')

			return fetch(`${WEB_API}${this.action}s/${id}/un${this.action}/`, {
				method: 'POST',
				headers,
			})
		}

		add(id) {
			const headers = new Headers(),
				cookies = getCookies(['csrftoken'])
			headers.append('x-csrftoken', cookies.csrftoken)
			headers.append('x-instagram-ajax', '1')
			headers.append('x-requested-with', 'XMLHttpRequest')

			return fetch(`${WEB_API}${this.action}s/${id}/${this.action}/`, {
				method: 'POST',
				headers,
			})
		}
	}

	window.getInstagram = Instagram
})(window)
