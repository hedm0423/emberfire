"use strict";

(function() {

  /* Only enable if Ember Data is included */
  if (window.DS === undefined) {
    return;
  }

  /**
    Something about the serializer
  */
  DS.FirebaseSerializer = DS.JSONSerializer.extend(Ember.Evented, {

    /**
      Called after `extractSingle()`. This method checks the model
      for `hasMany` relationships and makes sure the value is an array.
      If the value is an object, return the keys as an array.
    */
    normalize: function(type, hash) {
      var relationshipsByName = Ember.get(type, 'relationshipsByName');
      var relationshipNames = Ember.get(type, 'relationshipNames');
      // Check if the model contains any 'hasMany' relationships
      if (Ember.isArray(relationshipNames.hasMany)) {
        relationshipNames.hasMany.forEach(function (key) {
          var relationship = relationshipsByName.get(key);
          relationship.options.serializeAs = 'object';
          // Return the keys as an array
          if (typeof hash[key] === 'object' && !Ember.isArray(hash[key])) {
            hash[key] = Ember.keys(hash[key]);
            /*if (relationship.options && typeof relationship.options.serializeAs === 'undefined') {
              relationship.options.serializeAs = 'object';
            }*/
          }
          else if (Ember.isArray(hash[key])) {
            /*if (relationship.options && typeof relationship.options.serializeAs === 'undefined') {
              relationship.options.serializeAs = 'array';
            }*/
            Ember.warn('%@ relationship %@(\'%@\') will scale better if represented as a key/value map in Firebase. Example: {"%@":{"%@_id":true}`}'.fmt(type.toString(), relationship.kind, relationship.type.typeKey, relationship.key, relationship.type.typeKey));
            //throw new Error('%@ relationship %@(\'%@\') must be a key/value map in Firebase. Example: { "%@": { "%@_id": true } }'.fmt(type.toString(), relationship.kind, relationship.type.typeKey, relationship.key, relationship.type.typeKey));
          }
        });
      }
      return this._super.apply(this, arguments);
    },

    /**
      extractSingle
    */
    extractSingle: function(store, type, payload) {
      return this.normalize(type, payload);
    },

    /**
      Called after the adpter runs `findAll()` or `findMany()`. This method runs
      `extractSingle()` on each item in the payload and as a result each item
      will have `normalize()` called on it
    */
    extractArray: function(store, type, payload) {
      return payload.map(function(item) {
        return this.extractSingle(store, type, item);
      }.bind(this));
    },

    /**
      serializeHasMany
    */
    serializeHasMany: function(record, json, relationship) {
      var key = relationship.key;
      var relationshipType = DS.RelationshipChange.determineRelationshipType(record.constructor, relationship);

      if (record.get(key).get('length') === 0) { return; }

      if (relationship.kind === 'hasMany') {
        if (relationship.options) {
          relationship.options.serializeAs = relationship.options.serializeAs || 'array';
          switch (relationship.options.serializeAs) {
            case 'array':
              json[key] = record.get(key).mapBy('id');
              break;
            case 'object':
              json[key] = record.get(key).reduce(function(obj, item, idx) {
                obj[item.get('id')] = true;
                return obj;
              }, {});
              break;
          }
        }
      }
    }

  });

  /**
    The Firebase adapter allows your store to communicate with the Firebase
    realtime service. To use the adapter in your app, extend DS.FirebaseAdapter
    and customize the endpoint to point to the Firebase URL where you want this
    data to be stored.

    The adapter will automatically communicate with Firebase to persist your
    records as neccessary. Importantly, the adapter will also update the store
    in realtime when changes are made to the Firebase by other clients or
    otherwise.
  */
  DS.FirebaseAdapter = DS.Adapter.extend(Ember.Evented, {

    /**
      Endpoint paths can be customized by setting the Firebase property on the
      adapter:

      ```js
      DS.FirebaseAdapter.extend({
        firebase: new Firebase('https://<my-firebase>.firebaseio.com/')
      });
      ```

      Requests for `App.Post` would now target `https://<my-firebase>.firebaseio.com/posts`.

      @property firebase
      @type {Firebase}
    */

    init: function() {
      if (!this.firebase || typeof this.firebase !== 'object') {
        throw new Error('Please set the `firebase` property on the adapter.');
      }
      // If provided Firebase reference was a query (eg: limits), make it a ref.
      this._ref = this.firebase.ref();
    },

    // Uses push() to generate chronologically ordered unique IDs.
    generateIdForRecord: function() {
      return this._ref.push().name();
    },

    /**
      Called by the store to retrieve the JSON for a given type and ID. The
      method will return a promise which will resolve when the value is
      successfully fetched from Firebase.

      Additionally, from this point on, the object's value in the store will
      also be automatically updated whenever the remote value changes.
    */
    find: function(store, type, id) {
      var resolved = false;
      var ref = this._getRef(type, id);
      var serializer = store.serializerFor(type);

      return new Ember.RSVP.Promise(function(resolve, reject) {
        ref.on('value', function(snapshot) {
          var obj = snapshot.val();
          if (obj) {
            obj.id = snapshot.name();
          }
          if (!resolved) {
            // If this is the first event, resolve the promise.
            resolved = true;
            Ember.run(null, resolve, obj);
          } else {
            // If the snapshot is null, delete the record from the store
            if (obj === null && store.hasRecordForId(type, snapshot.name())) {
              store.getById(type, snapshot.name()).destroyRecord();
            }
            // Otherwise push it into the store
            else {
              store.push(type, serializer.extractSingle(store, type, obj));
            }
          }
        }, function(err) {
          // Only called in cases of permission related errors.
          if (!resolved) {
            Ember.run(null, reject, err);
          }
        });
      }, 'DS: FirebaseAdapter#find ' + type + ' to ' + ref.toString());
    },

    /**
      Called by the store to retrieve the JSON for all of the records for a
      given type. The method will return a promise which will resolve when the
      value is successfully fetched from Firebase.

      Additionally, from this point on, any records of this type that are added,
      removed or modified from Firebase will automatically be reflected in the
      store.
    */
    findAll: function(store, type) {
      var resolved = false;
      var ref = this._getRef(type);
      var serializer = store.serializerFor(type);

      function _gotChildValue(snapshot) {
        // Update store, only if the promise is already resolved.
        if (!resolved) {
          return;
        }
        var obj = snapshot.val();
        obj.id = snapshot.name();
        store.push(type, serializer.extractSingle(store, type, obj));
      }

      return new Ember.RSVP.Promise(function(resolve, reject) {
        var _handleError = function(err) {
          if (!resolved) {
            resolved = true;
            Ember.run(null, reject, err);
          }
        };

        ref.on('child_added', _gotChildValue, _handleError);
        ref.on('child_changed', _gotChildValue, _handleError);
        ref.on('child_removed', function(snapshot) {
          if (!resolved) {
            return;
          }
          var record = store.getById(type, snapshot.name());
          if (record !== null) {
            store.deleteRecord(record);
          }
        }, _handleError);

        ref.once('value', function(snapshot) {
          var results = [];
          snapshot.forEach(function(child) {
            var record = child.val();
            record.id = child.name();
            results.push(record);
          });
          resolved = true;
          Ember.run(null, resolve, results);
        });
      }, 'DS: FirebaseAdapter#findAll ' + type + ' to ' + ref.toString());
    },

    /**
      Called by the store when a newly created record is saved via the `save`
      method on a model record instance.

      The `createRecord` method serializes the record and send it to Firebase.
      The method will return a promise which will be resolved when the data has
      been successfully saved to Firebase.
    */
    createRecord: function(store, type, record) {
      var data = record.serialize({ includeId: false });
      var ref = this._getRef(type, record.id);
      return new Ember.RSVP.Promise(function(resolve, reject) {
        ref.set(data, function(err) {
          if (err) {
            Ember.run(null, reject, err);
          } else {
            Ember.run(null, resolve);
          }
        });
      }, 'DS: FirebaseAdapter#createRecord ' + type + ' to ' + ref.toString());
    },

    /**
      Update is the same as create for this adapter, since the number of
      attributes for a given model don't change.
    */
    updateRecord: function(store, type, record) {
      var data = record.serialize({ includeId: false });
      var ref = this._getRef(type, record.id);
      return new Ember.RSVP.Promise(function(resolve, reject) {
        ref.update(data, function(err) {
          if (err) {
            Ember.run(null, reject, err);
          } else {
            Ember.run(null, resolve);
          }
        });
      }, 'DS: FirebaseAdapter#updateRecord ' + type + ' to ' + ref.toString());
    },

    // Called by the store when a record is deleted.
    deleteRecord: function(store, type, record) {
      var ref = this._getRef(type, record.id);
      return new Ember.RSVP.Promise(function(resolve, reject) {
        ref.remove(function(err) {
          if (err) {
            Ember.run(null, reject, err);
          } else {
            Ember.run(null, resolve);
          }
        });
      }, 'DS: FirebaseAdapter#deleteRecord ' + type + ' to ' + ref.toString());
    },

    /**
      Determines a path fo a given type. To customize, override the method:

      ```js
      DS.FirebaseAdapter.reopen({
        pathForType: function(type) {
          var decamelized = Ember.String.decamelize(type);
          return Ember.String.pluralize(decamelized);
        }
      });
      ```
    */
    pathForType: function(type) {
      var camelized = Ember.String.camelize(type);
      return Ember.String.pluralize(camelized);
    },

    /**
      Returns a Firebase reference for a given type and optional ID.

      By default, it pluralizes the type's name ('post' becomes 'posts'). To
      override the pluralization, see [pathForType](#method_pathForType).

      @method _getRef
      @private
      @param {String} type
      @param {String} id
      @returns {Firebase} ref
    */
    _getRef: function(type, id) {
      var ref = this._ref;
      if (type) {
        ref = ref.child(this.pathForType(type.typeKey));
      }
      if (id) {
        ref = ref.child(id);
      }
      return ref;
    }

  });

})();