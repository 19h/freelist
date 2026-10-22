'use strict';

// Array#push cannot grow an array beyond this length. No storage is preallocated.
var MAX_CAPACITY = 0xFFFFFFFF;

function noop() {}

function validateCapacity(value, name) {
    if (typeof value !== 'number') {
        throw new TypeError(name + ' must be a number');
    }
    if (value < 0 || value > MAX_CAPACITY || Math.floor(value) !== value) {
        throw new RangeError(name + ' must be an integer between 0 and 4294967295');
    }
}

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
    validateCapacity(max, 'max');
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

/**
 * Number of currently cached values, excluding checked-out values.
 * @name FreeList#size
 * @type {number}
 * @readonly
 */
Object.defineProperty(FreeList.prototype, 'size', {
    get: function () {
        return this.list.length;
    }
});

/**
 * Remove all cached references without disposing of the values.
 * The cache array's identity and the configured capacity are preserved.
 *
 * @returns {number} Number of removed values.
 */
FreeList.prototype.clear = function () {
    var removed = this.list.length;
    this.list.length = 0;
    return removed;
};

/**
 * Transfer all cached values to the caller in FIFO order, emptying the cache.
 * The caller may reuse or dispose of the returned values.
 *
 * @returns {Array} Removed values in allocation order.
 */
FreeList.prototype.drain = function () {
    return this.list.splice(0);
};

/**
 * Retain at most size cached values, preserving the oldest entries.
 * Does not change the configured capacity or dispose of removed values.
 * Validation completes before the cache is modified.
 *
 * @param {number} size Non-negative integer, at most 4294967295.
 * @returns {Array} Removed newest entries, in their original FIFO order.
 * @throws {TypeError} If size is not a number.
 * @throws {RangeError} If size is not an integer within the supported range.
 */
FreeList.prototype.trim = function (size) {
    validateCapacity(size, 'size');
    return this.list.splice(size);
};

/**
 * Change capacity, retaining the oldest values when shrinking the cache.
 * Increasing capacity does not create values or preallocate storage.
 * Validation completes before the capacity or cache is modified.
 *
 * @param {number} max New capacity, with the constructor's numeric constraints.
 * @returns {Array} Evicted values in their original FIFO order.
 * @throws {TypeError} If max is not a number.
 * @throws {RangeError} If max is not an integer within the supported range.
 */
FreeList.prototype.resize = function (max) {
    validateCapacity(max, 'max');
    this.max = max;
    return this.list.splice(max);
};

// Support both require('freelist') and require('freelist').FreeList.
FreeList.FreeList = FreeList;

module.exports = FreeList;
