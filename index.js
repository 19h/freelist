'use strict';

// Array#push cannot grow an array beyond this length. No storage is preallocated.
var MAX_CAPACITY = 0xFFFFFFFF;

function noop() {}

/**
 * Create a bounded, first-in-first-out pool of reusable values.
 *
 * The limit applies to cached values, not to allocations or checked-out values.
 * The factory runs only when the cache is empty; it is called with the pool as
 * `this` and with the arguments passed to alloc(). It is not invoked with `new`.
 *
 * @constructor
 * @param {*} name Descriptive metadata; not used to identify or share pools.
 * @param {number} max Integer cache capacity from 0 through 4294967295.
 * @param {Function|null} [factory] Produces a value on a cache miss. Defaults
 *   to a function returning undefined when omitted or null.
 * @throws {TypeError} If called without new, max is not a number, or a supplied
 *   factory is not a function.
 * @throws {RangeError} If max is not an integer within the supported range.
 */
function FreeList(name, max, factory) {
    if (!(this instanceof FreeList)) {
        throw new TypeError('FreeList must be called with new');
    }
    if (typeof max !== 'number') {
        throw new TypeError('max must be a number');
    }
    if (max < 0 || max > MAX_CAPACITY || Math.floor(max) !== max) {
        throw new RangeError('max must be an integer between 0 and 4294967295');
    }
    if (factory != null && typeof factory !== 'function') {
        throw new TypeError('factory must be a function');
    }

    this.name = name;
    this.max = max;

    // Historical public fields: preserve their names and the array's identity.
    // In particular, instance.constructor is the factory, not the FreeList class.
    this.constructor = factory == null ? noop : factory;
    this.list = [];
}

/**
 * Take the oldest cached value, or call the factory if the cache is empty.
 *
 * Cached values are returned unchanged; arguments are ignored on a cache hit.
 * Factory results and exceptions pass through unchanged.
 *
 * @param {...*} args Arguments forwarded to the factory on a cache miss.
 * @returns {*} A cached value or the factory's result.
 */
FreeList.prototype.alloc = function () {
    if (this.list.length > 0) {
        return this.list.shift();
    }
    return this.constructor.apply(this, arguments);
};

/**
 * Cache a value if capacity remains. Values are neither reset nor disposed.
 *
 * No ownership or duplicate check is performed. Freeing the same object twice
 * can cause later allocations to return aliases to that object.
 *
 * @param {*} value Value to make available for reuse, including undefined.
 * @returns {boolean} True if retained; false if the cache was already full.
 */
FreeList.prototype.free = function (value) {
    if (this.list.length >= this.max) {
        return false;
    }
    this.list.push(value);
    return true;
};

// Support both require('freelist') and require('freelist').FreeList.
FreeList.FreeList = FreeList;

module.exports = FreeList;
