requirejs.config({
    //By default load any module IDs from js/lib
    baseUrl: 'TemplateData/scripts',
    //except, if the module ID starts with "app",
    //load it from the js/app directory. paths
    //config is relative to the baseUrl, and
    //never includes a ".js" extension since
    //the paths config could be for a directory.
    // paths: {
    //     app: '../app'
    // }
    shim: {
        'bootstrap': ['jquery']
    }
});

requirejs(['jquery', 'underscore', 'bootstrap', 'UnityProgress'],
function($, _, bootstrap, UnityProgress) {
  $(
    () => {

      function ID() {
        // Math.random should be unique because of its seeding algorithm.
        // Convert it to base 36 (numbers + letters), and grab the first 9 characters
        // after the decimal.
        return '_' + Math.random().toString(36).substr(2, 9);
      };

      const playerID = ID();

      let gameInstance = null;
      let getParams = parseGet();
      window.game_build = 'build' in getParams ? getParams['build'] : window.game_build;
      window.game_url = 'build' in getParams ? `${window.game_build}/Build/thor-local-WebGL.json` : window.game_url;
      let scene = getParams['scene'];
      if (!scene) {
        scene = 'FloorPlan302_physics';
      }
      console.log("GAME URL: ", window.game_url);
      let hider = getParams['role'] !== 'seeker';
      let gameInitialized  = false;
      let objectId = '';
      let spawnRandomSeed = 'spawnSeed' in getParams ? parseInt(getParams['spawnSeed']) : 10;
      let objectsRandomSeed = 'objectsSeed' in getParams ? parseInt(getParams['objectsSeed']) : 0;
      let outputData = {
        object_type: getParams['object'],
        object_variation: getParams['variation'],
        open_objects: [],
        actions: []
      };
      let gameConfig = null;
      let lastMetadadta = null;
      let reachablePositions = null;

      let isTurkSanbox = 'sandbox' in getParams && getParams['sandbox'].toLowerCase() === 'true';
      const turkSandboxUrl = 'https://workersandbox.mturk.com/mturk/externalSubmit';
      const turkUrl = 'https://www.mturk.com/mturk/externalSubmit';

      let pickupFailTimeout = false;
      let hasObject = false;

      const csrf_token = $('#csrf').val();
      $.ajaxSetup({
          beforeSend: function(xhr, settings) {
              if (!/^(GET|HEAD|OPTIONS|TRACE)$/i.test(settings.type) && !this.crossDomain) {
                  xhr.setRequestHeader("X-CSRFToken", csrf_token);
              }
          }
      });

      class Instruction {
        constructor(text, evaluator, id) {
          this.text = text;
          this.evaluator = evaluator;
          this.id = id;
        }

        evaluate(metadata) {
          if (this.evaluator) {
            return this.evaluator(metadata);
          }

          return false;
        }

        l2(a, b) {
           return a
               .map((x, i) => Math.abs( x - b[i] ) ** 2) // square the difference
               .reduce((sum, now) => sum + now) // sum
               ** (1/2);
        }

        findObjectsByPattern(re, objectArray) {
          return objectArray.filter((obj) => re.test(obj.name));
        }
      }

      class ObjectActionInstruction extends Instruction {
        constructor(text, objectPattern, actionPattern, id, checker) {
          super(text, null, id);
          this.objectRE = new RegExp(objectPattern);
          this.actionRE = new RegExp(actionPattern);
          if (checker) {
              this.checker = checker;
          } else {
              this.checker = (metadata) => {return metadata.lastActionSuccess;};
          }
        }

        evaluate(metadata) {
          return this.actionRE.test(metadata.lastAction) && this.objectRE.test(metadata.lastActionObjectName) && this.checker(metadata);
        }
      }

      class RepeatedObjectActionInstruction extends ObjectActionInstruction {
        constructor(text, objectPattern, actionPattern, times, id) {
          super(text, objectPattern, actionPattern, id);
          if (!times) {
            times = 2;
          }
          this.times = times;
          this.counter = 0;
          this.blackList = [];
        }

        evaluate(metadata) {
          if (!this.blackList.includes(metadata.lastActionObjectName) && super.evaluate(metadata)) {
            this.blackList.push(metadata.lastActionObjectName);
            this.counter += 1;
          }

          return (this.counter >= this.times);
        }
      }

      class ObjectActionPositionInstruction extends ObjectActionInstruction {
        constructor(text, objectPattern, actionPattern, position, id, tolerance = 0.01) {
          super(text, objectPattern, actionPattern, id);
          this.position = position;
          this.tolerance = tolerance;
        }

        evaluate(metadata) {
          let pos = metadata.lastActionObject.position;
          let posArr = [pos.x, pos.y, pos.z];
          return super.evaluate(metadata) && super.l2(posArr, this.position) < this.tolerance;
        }
      }

      class ObjectStatusInstruction extends Instruction {
        constructor(text, objectPattern, statusName, id, statusValue = true) {
          super(text, null, id);
          this.objectRE = new RegExp(objectPattern);
          this.statusName = statusName;
          this.statusValue = statusValue;
        }

        evaluate(metadata) {
          const filtered = this.findObjectsByPattern(self.objectRE, metadata.allObjects);
          for (const targetObject of filtered) {
            if (targetObject[this.statusName] == this.statusValue) {
              return true;
            }
          }
          return false;
        }
      }

      class ObjectPositionInstruction extends Instruction {
        constructor(text, objectPattern, position, id, tolerance = 0.25) {
          super(text, null, id);
          this.objectRE = new RegExp(objectPattern);
          this.position = position;
          this.tolerance = tolerance;
        }

        evaluate(metadata) {
          const filtered = this.findObjectsByPattern(self.objectRE, metadata.allObjects);
          for (const targetObject of filtered) {
            let pos = targetObject.position;
            let posArr = [pos.x, pos.y, pos.z];
            if (super.l2(posArr, this.position) < this.tolerance) {
              return true;
            }
          }
          return false;
        }
      }

      // Instruction steps
      // 1 Open the fridge
      // 2 Pick up the apple from the table
      // 3 Put it in the fridge
      // 4 Close the fridge
      // 5 Pick up the pot
      // 6 Fill it with water
      // 7 Put it on the stove

      // const instructions = [
      //   new ObjectActionInstruction('Open the fridge', 'Fridge', 'OpenObject'),
      //   new ObjectActionInstruction('Pick up the apple from the table', 'Apple', 'PickupObject'),
      //   new ObjectPositionInstruction('Put the apple in the fridge', 'Apple', [-2.145, 0.845, 1.13]),
      //   new ObjectActionInstruction('Close the fridge', 'Fridge', 'CloseObject'),
      //   new ObjectActionInstruction('Pick up the pot', 'Pot', 'PickupObject'),
      //   new ObjectStatusInstruction('Fill the pot with water', 'Pot', 'isFilledWithLiquid')
      // ];

      const instructions = [
        new RepeatedObjectActionInstruction('Many objects can be picked up.<br>Pick up and drop at least two different objects. ', '.*', 'PickupObject', 2),
        new ObjectActionInstruction('Once you pick up an object, you can move it closer or farther away.<br>First, pick up an object.', '.*', 'PickupObject'),
        new ObjectActionInstruction('Now, use the scrollwheel to move it.', '.*', 'MoveHandDelta'),
        new ObjectActionInstruction('Now drop the object.', '.*', 'ThrowObject'),
        new ObjectActionInstruction('For practice, now pick up another object.', '.*', 'PickupObject'),
        new ObjectActionInstruction('Now move it all the way in, as close to you as possible.', '.*', 'MoveHandDelta', null, (metadata) => {
          return (metadata.lastActionSuccess == false) && (metadata.lastActionZ < 0);
        }),
        new ObjectActionInstruction('Now move it all the way out, as far away from you as possible.', '.*', 'MoveHandDelta', null, (metadata) => {
          return (metadata.lastActionSuccess == false) && (metadata.lastActionZ > 0);
        }),
        new ObjectActionInstruction('Now drop the object.', '.*', 'ThrowObject'),
        new RepeatedObjectActionInstruction('Other objects can be opened and closed.<br>Open at least two different objects. ', '.*', 'OpenObject', 2),
        new ObjectActionInstruction('Other yet objects can be toggled (switched on and off).<br>Find one and toggle it.', '.*', 'ToggleObject.*'),
        // new ObjectActionInstruction('Do we want another instruction on object states?', '.*', 'ToggleObject.*'),
      ];

      instructions.forEach((instruction, index) => {
        if (!instruction.id) {
          instruction.id = `instruction-${index}`;
        }
        const message = `<div class="log-message" id="${instruction.id}" style="display: none;">
          ${instruction.text}
          </div>`;
        $('#instructions').append(message);
      });

      let currentInstructionIndex = 0;
      $(`#${instructions[currentInstructionIndex].id}`).css('font-weight', 'bold').css('display', 'block');

      function instructionsEventHandler(metadata) {
        if (currentInstructionIndex >= instructions.length) {
          return;
        }

        let currentInstruction = instructions[currentInstructionIndex];
        if (currentInstruction.evaluate(metadata)) {
          $(`#${currentInstruction.id}`).css('font-weight', 'normal').css('color', 'grey').css('text-decoration', 'line-through');
          currentInstructionIndex += 1;
          if (currentInstructionIndex < instructions.length) {
            $(`#${instructions[currentInstructionIndex].id}`).css('font-weight', 'bold').css('display', 'block');
          } else {
            $('#end-tutorial-button').css('display', 'block');
          }
        }
      }

      function resetScene() {
        gameInstance.SendMessage('PhysicsSceneManager', 'SwitchScene', scene);
        gameInstance.SendMessage('FPSController', 'Step', JSON.stringify({
          action: "RandomlyMoveAgent",
          randomSeed: spawnRandomSeed
        }));
      }

      $('#end-tutorial-button').click(() => {
        scene = 'FloorPlan326_physics';
        resetScene();

        $('#end-tutorial-button').css('display', 'none');
        $('#instructions').empty();
        const message = `<div class="log-message" id="post-tutorial-instruction">
          Now, please explore the new room.<br>
          When you're ready, please create a game that can be scored (either as success or failure, or by points).<br>
          When you're done, click the button below:
          </div>`;
        $('#instructions').append(message);
        $('#game-ready-button').css('display', 'block');
      });

      $('#game-ready-button').click(function() {
        $('#game-ready-button').css('display', 'none');
        $('#game-form').css('display', 'block');
      });

      $('#game-form .form-control').keyup(() => {
        const values = [$('#game-name-input').val().trim(),
          $('#game-description-input').val().trim(),
          $('#game-scoring-input').val().trim()];

        if (values.every((val) => { return val.length > 0;})) {
          $('#game-form button[type=submit]').removeAttr('disabled');
        } else {
          $('#game-form button[type=submit]').attr('disabled', 'disabled');
        }
      });

      $('#game-score-form .form-control').keyup(() => {
        const values = [$('#game-score-input').val().trim(),
          $('#game-score-explanation').val().trim()];

        if (values.every((val) => { return val.length > 0;})) {
          $('#game-score-form button[type=submit]').removeAttr('disabled');
        } else {
          $('#game-score-form button[type=submit]').attr('disabled', 'disabled');
        }
      });

      let gameInfo = {};

      $('#game-form').submit((event) => {
        event.preventDefault();
        // console.log(event);
        const form = $('#game-form');
        form.append(`<input type="hidden" name="player_id" value="${playerID}" />`);
        // Adding the timestamp on the server-side
        // form.append(`<input type="hidden" name="timestamp" value="${Date.now()}" />`);

        form.serializeArray().forEach((formField) => {
          gameInfo[formField.name] = formField.value;
        });

        $.ajax({
          url: 'save_game',
          type: 'POST',
          data: form.serialize(),
          // contentType: 'application/json',
          beforeSend: function() {
            return;
          }
            // TODO: show a message after submitting while it's saving?
        }).done(function(data) {
            console.log('Done save_game data:');
            console.log(data);
            gameInfo['id'] = data['id']
            startGamePlay();
        });
        // Optionally, can add .always or .fail handlers, or use .then to deal with $.Deferred
      });

      function createGameSpan(text) {
        return `<span class="game-info-span">${text}</span>`;
      }

      function startGamePlay() {
        $('#play-game-name').append(createGameSpan(gameInfo.name));
        $('#play-game-description').append(createGameSpan(gameInfo.description));
        $('#play-game-scoring').append(createGameSpan(gameInfo.scoring));

        $('#instructions').css('display', 'none');
        $('#game-form').css('display', 'none');
        $('#play-game').css('display', 'block');
      }

      $('#game-score-form').submit((event) => {
        event.preventDefault();
        const form = $('#game-score-form');
        form.append(`<input type="hidden" name="player_id" value="${playerID}" />`);
        form.append(`<input type="hidden" name="game_id" value="${gameInfo.id}" />`);

        $.ajax({
          url: 'save_game_score',
          type: 'POST',
          data: form.serialize(),
          // contentType: 'application/json',
          beforeSend: function() {
            return;
          }
            // TODO: show a message after submitting while it's saving?
        }).done(function(data) {
            console.log('Done save_game_score data:');
            console.log(data);
            afterGameScore();
        });
      });

      function endExperiment() {
        // TODO: transition to any post-experiment questionnaires
        // TODO: show an alert for the time being
        alert('Thank you for completing the experiment!');
      }

      function afterGameScore() {
        $(':input', '#game-score-form')
          .not(':button, :submit, :reset, :hidden')
          .val('')
          .prop('checked', false)
          .prop('selected', false);

        $('#play-game').css('display', 'none');

        // First, send the ajax request to get another game
        // only if there's a valid one, offer the chance to end

        $.ajax({
          url: `find_game_to_play/${playerID}`,
          type: 'GET',
          // data: {player_id: playerID},
        }).done(function(result) {
          if ('status' in result && result['status']) {
              $('#play-another-game').css('display', 'block');
              gameInfo = result['game'];
          } else {
            endExperiment();
          }
        });
      }

      $('#play-another-game-button').click(function() {
        $('#play-another-game').css('display', 'none');
        $('.game-info-span').remove();
        startGamePlay();
      });

      $('#end-experiment-button').click(endExperiment);

      $('#reset-scene').click(() => {
        $('#reset-scene').blur();
        resetScene();
      });

      // function savaData(url, type, ajaxData) {
      //   console.log('Ajax data:');
      //   console.log(ajaxData);
      //   $.ajax({
      //     url: url,
      //     type: type,
      //     data: JSON.stringify({name: 'test', value: 'test value'}),
      //     contentType: 'application/json',
      //     beforeSend: function() {
      //       return;
      //     }
      //       // TODO: show a message after submitting while it's saving?
      //   }).done(function(data) {
      //       console.log('Done data:');
      //       console.log(data);
      //       startGamePlay(ajaxData);
      //   });
      //   // Optionally, can add .always or .fail handlers, or use .then to deal with $.Deferred
      // }

      // Utils
      function paramStrToAssocArray(prmstr) {
        let params = {};
        let prmarr = prmstr.split('&');
        for (let i = 0; i < prmarr.length; i++) {
          let tmparr = prmarr[i].split('=');
          params[tmparr[0]] = tmparr[1];
        }
        return params;
      }

      function parseGet() {
        let paramStr = window.location.search.substr(1);
        return paramStr !== null && paramStr !== ''
          ? paramStrToAssocArray(paramStr)
          : {};
      }

      /////////////////////
      ///// Unity callbacks
      window.onGameLoaded = function() {
        if (!gameInitialized) {
          resetScene();
          gameInitialized = true;

          // gameInstance.SendMessage('FPSController', 'Step', JSON.stringify({
          //   action: "RandomlyMoveAgent",
          //   randomSeed: spawnRandomSeed
          // }));
        }
      };

      window.onUnityMetadata = function(metadata) {
        let jsonMeta = JSON.parse(metadata);

        // FIRST init event
        console.log('Unity Metadata:');
        console.log(jsonMeta);

        handleEvent(jsonMeta);
        lastMetadadta = jsonMeta;
      };

      window.onUnityEvent = function(event) {
        // Logic for handling unity events
        // console.log('Unity Event:');
        // console.log(JSON.parse(event));
      };

      window.onUnityMovement = function(movement) {
        let jsonMovement = JSON.parse(movement);
        // FIRST init event
        // console.log('Unity Movement:');
        // console.log(jsonMovement);
      };

      // Aggregate data
      function gatherFinalState(metadata) {
        let agentMetadata = metadata.agents[0];
        let filtered = agentMetadata.objects.filter((obj) => obj.objectId === objectId);
        if (filtered.length === 1) {
          let object = filtered[0];

          outputData['object_position'] = object.position;
          outputData['object_rotation'] = object.rotation;
          outputData['open_objects'] = agentMetadata.objects.filter((obj) => obj.isOpen).map(obj => obj.objectId);

          outputData['object_locations_and_rotations'] = agentMetadata.objects.reduce((acc, obj, {}) => {
            return {
              ...acc,
              [obj.objectId]:{
                position: obj.position,
                rotation: obj.rotation
              }
            }
          });
        }
        else {
          throw `Invalid id ${objectId} in metadata.objects: ${agentMetadata.objects}`;
        }
        return outputData;
      }

      // Submit to turk
      function submitHit(metadata) {
        let data = gatherFinalState(metadata);
        document.forms['mturk_form'].assignmentId.value = getParams['assignmentId'];
        console.log('Turk submit!!', data);
        document.forms['mturk_form'].data.value = JSON.stringify(data);
        // document.forms['mturk_form'].submit();
        window.parent.postMessage(JSON.stringify(data), '*');
      }

      ///////////////////////
      ///// Hider's Handlers

      function Move(metadata) {
        outputData.trayectory.push(metadata.agents[0].agent.position);
      }

      function CreateObject(metadata) {
        let agentMetadata = metadata.agents[0];
        let actionSuccess = agentMetadata.lastActionSuccess;
        if (!actionSuccess) {
          throw `Action '${agentMetadata.lastAction}' failed with error: "${agentMetadata.errorMessage}"' `
        }

        objectId = agentMetadata.actionReturn;
        hasObject = true;
        outputData['target_id'] = objectId;

        gameInstance.SendMessage('FPSController', 'SpawnAgent', spawnRandomSeed);

        gameInstance.SendMessage('FPSController', 'DisableObjectCollisionWithAgent', objectId);

        $("#finish-hit").click((e) => {
          // The callback for ExhaustiveSearchForItem action will call submitHit
          // with visibility information of the hiding spot
          gameInstance.SendMessage ('FPSController', 'Step', JSON.stringify({
            "action": "ExhaustiveSearchForItem",
            "objectId": objectId,
            "positions": reachablePositions
          }));
        });

        $("#debug-json").click((e) => {
          debugPrintJson(lastMetadadta)
        });

        $("#reset-hit").click((e) => {
          $("#reset-hit").blur();
          gameInstance.SendMessage ('PhysicsSceneManager', 'SwitchScene', outputData.scene);
        }).attr("disabled", false);

        $("#move").click((e) => {
          gameInstance.SendMessage ('FPSController', 'Step', JSON.stringify({
            action: "MoveAhead",
            moveMagnitude:  0.25
          }));
        })

      }

      function OpenObject(metadata) {
        let agentMetadata = metadata.agents[0];
      }

      function RegisterAgentPosition(metadata) {
        let agentMetadata = metadata.agents[0];
        let agent = agentMetadata.agent;
        outputData['agent_start_location'] =
          {
            "x": agent.position.x,
            "y": agent.position.y,
            "z": agent.position.z,
            "rotation": agent.rotation.y,
            "horizon": agent.cameraHorizon,
            "standing": agentMetadata.isStanding
          };
      }

      function ExhaustiveSearchForItem(metadata) {
        let agentMetadata = metadata.agents[0];
        outputData['visibility'] = {
          objectSeen: agentMetadata.actionReturn['objectSeen'],
          positionsTried: agentMetadata.actionReturn['positionsTried']
        };
        submitHit(metadata);
      }

      function PickupObject(metadata) {
        $("#finish-hit").attr("disabled", true);
        let agentMetadata = metadata.agents[0];
        hasObject = agentMetadata.lastActionSuccess;
        if (pickupFailTimeout) {
          clearTimeout(pickupFailTimeout);
        }
      }

      function DropObject(metadata) {
        let agentMetadata = metadata.agents[0];
        hasObject = !agentMetadata.lastActionSuccess;
        if (pickupFailTimeout) {
          clearTimeout(pickupFailTimeout);
        }
        $("#finish-hit").attr("disabled", false);
      }

      ///////////////////////
      ///// Seeker's Handlers
      function CreateObjectAtLocation(metadata) {
        let agentMetadata = metadata.agents[0];
        gameInstance.SendMessage('FPSController', 'SetOnlyObjectIdSeeker', agentMetadata.actionReturn);
        gameInstance.SendMessage('FPSController', 'DisableObjectCollisionWithAgent', agentMetadata.actionReturn);
        objectId = gameConfig.target_id;
      }

      function FoundObject(metadata) {
        let agentMetadata = metadata.agents[0];
        let pickedObjectId = agentMetadata.actionReturn;
        if (pickedObjectId === objectId) {
          console.log("Success!!");
          outputData['success'] = true;
          $("#message-text").html("<strong class='green-text'>You Found the object!</strong>").show();
          // Auto submit
          setTimeout(() => {
            submitHit(lastMetadadta)
          }, 1000);
        }
      }

      function InitScene(metadata) {
        console.log("--- ", metadata.agents[0].sceneName);
        outputData['scene'] = metadata.agents[0].sceneName;
        outputData['trayectory'] = [];
        outputData['actions'] = [];

        gameInstance.SendMessage ('FPSController', 'Step', JSON.stringify({
          action: "RandomizeHideSeekObjects",
          randomSeed: objectsRandomSeed,
          removeProb: 0.0,
        }));

        ["Cup", "Mug", "Bread", "Tomato", "Plunger", "Knife"]
          .forEach(
            k => gameInstance.SendMessage(
              'FPSController',
              'Step',
              JSON.stringify({action: "DisableAllObjectsOfType", objectId: k})
            )
          );

        if (hider) {
          let objectName = getParams['object'];
          let objectVariation = parseInt(getParams['variation']);
          gameInstance.SendMessage('FPSController', 'SpawnObjectToHide',  JSON.stringify(
            {
              objectType: objectName,
              objectVariation: objectVariation,
            }
          ));
        }
        else {
          gameInstance.SendMessage('FPSController', 'Step', JSON.stringify({
            action: "TeleportFull",
            x: gameConfig.agent_start_location.x,
            y: gameConfig.agent_start_location.y,
            z: gameConfig.agent_start_location.z,
            horizon:  gameConfig.agent_start_location.horizon,
            rotation: {x: 0.0, y: gameConfig.agent_start_location.rotation, z: 0.0},
            standing: gameConfig.agent_start_location.standing
          }));
          gameInstance.SendMessage('FPSController', 'Step', JSON.stringify({
            action: "CreateObjectAtLocation",
            position: gameConfig.object_position,
            rotation: gameConfig.object_rotation,
            forceAction: true,
            objectType: gameConfig.object_type,
            objectVariation: gameConfig.object_variation,
            randomizeObjectAppearance: false
          }));
        }
      }

      let eventHandlers = {
        hider: {
          [null]: InitScene,
          MoveAhead: Move,
          MoveBack: Move,
          MoveLeft: Move,
          MoveRight: Move,
          DropHandObject: DropObject,
          CreateObject: CreateObject,
          OpenObject: OpenObject,
          RandomlyMoveAgent: RegisterAgentPosition,
          ExhaustiveSearchForItem: ExhaustiveSearchForItem,
          PickupObject: PickupObject
        },
        seeker: {
          [null]: InitScene,
          MoveAhead: Move,
          MoveBack: Move,
          MoveLeft: Move,
          MoveRight: Move,
          OpenObject: OpenObject,
          PickupObject: FoundObject,
          CreateObjectAtLocation: CreateObjectAtLocation
        }
      };

      function handleEvent(metadata) {
        let action = metadata.agents[0].lastAction;
        let role = hider ? 'hider' : 'seeker';
        let handler = eventHandlers[role][action];
        if (handler !== undefined) {
          handler(metadata);
        }
        let agentMetadata = metadata.agents[0];
        let agent = agentMetadata.agent;
        let potentialObjects = agentMetadata.objects.filter((obj) => { return obj.objectId == agentMetadata.lastActionObjectId });
        let matchingObject = null;
        if (potentialObjects.length == 1) {
          matchingObject = potentialObjects[0];
        }

        let eventMetadata = {
          lastAction: agentMetadata.lastAction,
          lastActionSuccess: agentMetadata.lastActionSuccess,
          lastActionObjectId: agentMetadata.lastActionObjectId,
          lastActionObjectName: agentMetadata.lastActionObjectName,
          lastActionX: agentMetadata.lastActionX,
          lastActionY: agentMetadata.lastActionY,
          lastActionZ: agentMetadata.lastActionZ,
          lastActionObject: matchingObject,
          agent: {
            x: agent.position.x,
            y: agent.position.y,
            z: agent.position.z,
            rotation: agent.rotation.y,
            horizon: agent.cameraHorizon,
            standing: agentMetadata.isStanding
          },
          allObjects: agentMetadata.objects
        };
        outputData.actions.push(eventMetadata);
        logEvent(eventMetadata);
        instructionsEventHandler(eventMetadata);

        if (eventMetadata.lastAction == 'MoveHandDelta') {
          console.log(`MoveHand | status: ${eventMetadata.lastActionSuccess} | direction: ${eventMetadata.lastActionZ > 0} `);
        }
      }

      const MAX_LOG_EVENTS = 10;

      function logEvent(meta) {
        console.log(meta);

        if (meta.lastAction) {
          while ($('#event-log').children().length >= MAX_LOG_EVENTS) {
            $('#event-log').children().last().remove();
          }

          const formatter = new Intl.NumberFormat({maximumSignificantDigits: 3});
          let objectName = meta.lastActionObjectId.split("|", 1)[0];
          let objectId = '';
          if (meta.lastActionObjectName) {
              const objectSplit = meta.lastActionObjectName.split('_');
              objectName = objectSplit[0];
              objectId = objectSplit[1];
          }

          const message = `<div class="log-message" style="color: ${meta.lastActionSuccess ? "green" : "red"}">
            Action ${meta.lastAction}
            on ${objectName}${objectId ? " (" + objectId + ")" : ""}
            at location (${formatter.format(meta.agent.x)}, ${formatter.format(meta.agent.y)}, ${formatter.format(meta.agent.z)})
            which ${meta.lastActionSuccess ? "succeeded" : "failed"}
            </div>`;
          $('#event-log').prepend(message);
        }
      }

      $('#event-log-reset').click(function() {
        $('#event-log').empty();
      });

      function initGame(url) {
        const t0 = performance.now();
        gameInstance = UnityLoader.instantiate("gameContainer", url, {
          onProgress: UnityProgress.UnityProgress, Module: {
            onRuntimeInitialized: function () {
              // At this point unity loaded successfully
              UnityProgress.UnityProgress(gameInstance, "complete");
              const t1 = performance.now();
              console.log(`Load finished. Took: ${(t1 - t0) / 1000}s`);

              // Adding this to allow keyboard input to be captured when focused
              $('canvas').attr("tabindex", "1");

              var container = document.getElementById("gameContainer");
              container.addEventListener('click', function () {
                if (document.pointerLockElement === null) {
                  this.requestPointerLock();
                  gameInstance.SendMessage('FPSController', 'EnableMouseControl');
                }
              });
            },
          }
        });
      }


      // Unity Loader Script
      $.getScript(`${window.game_build}/Build/UnityLoader.js` )
        .done(function( script, textStatus ) {

          console.log("Status: ", textStatus);

          $('#role-str').html(('role' in getParams ? getParams['role'] : 'hider').toUpperCase());
          $("#mturk_form").attr("action", isTurkSanbox ? turkSandboxUrl : turkUrl);

          // Instruction Rendering
          if (hider) {
              let objectHtml = `<strong class="important-text">${getParams['object']}</strong>`;
              // $("#instruction-text").html(`You have to hide a ${objectHtml}`);
              // $("#instruction-2").html(`Move around in the room, open drawers and cabinets to look for a good hiding spot.`);
              // $("#instruction-3").html('When you are ready, move the object (see Shift controls) to place it more precisely, click on it to drop it.');
              // $("#instruction-4").html(`If you're happy with your hiding spot click the <strong class="green-text">Finish</strong> button above. Or <strong class="red-text">Reset</strong> to start over.`);
              //  $("#instruction-5").html("If a door/drawer opens and closes, it means you're in the way! Move back and try again.");
              //  $("#instruction-6").html("If you're clicking on the object and it's not being picked up, try moving closer to the object! (within 1.5 meters)");
              // $("#instructions-hider").show();

              $(document).keypress(function(event) {
                  if (event.keyCode === 32) {
                  if(event.shiftKey && !hasObject){
                      pickupFailTimeout = setTimeout(() => {
                          $("#last-action-text").html(`Action Failed: <strong class="red-text">Pick Up Failed</strong>`).show();
                      }, 800)
                  } else {

                  }
                  }
              });
            initGame(window.game_url);
            if ("onpointerlockchange" in document) {
              document.addEventListener('pointerlockchange', lockChangeAlert, false);
            } else if ("onmozpointerlockchange" in document) {
              document.addEventListener('mozpointerlockchange', lockChangeAlert, false);
            }

            function lockChangeAlert() {
              if (document.pointerLockElement === null) {
                gameInstance.SendMessage('FPSController', 'DisableMouseControl');
              }
            }
          }
          else {
            // Uses a hider game data to create a game
            $.getJSON(
                `https://thor-turk.s3-us-west-2.amazonaws.com/hide-n-seek/data/hider/${getParams['config']}`,
                function(config) {
                    console.log("------ Config", config);
                    gameConfig = config;
                    $("#instructions-seeker").show();
                    $("#message-text").show();
                    // gameConfig['agentPosition']
                    let objectHtml = `<strong class="important-text">${gameConfig.object_type}</strong>`;
                    $("#instruction-text").html(`You have to find a ${objectHtml}`);
                    $("#instruction-2").html(`Move around in the room, open drawers and cabinets to look for a ${objectHtml}.`);
                    $("#instruction-3").html('Click on it once you have found it.');
                    $("#instruction-4").html(`If you cannot find the ${objectHtml} after some time, you can click the <strong class="red-text">Give Up</strong> button above.`);
                    getParams['object'] = gameConfig['object_type'];
                    getParams['variation'] = gameConfig['object_variation'];

                    outputData.object_type = gameConfig['object_type'];
                    outputData.object_variation = gameConfig['object_variation'];

                    $("#finish-hit").click((e) => {
                          outputData['success'] = false;
                          submitHit(lastMetadadta);

                    }).text("Give Up").toggleClass("giveup-btn");


                    $("#reset-hit").hide();

                    setTimeout(() => {
                         $("#finish-hit").attr("disabled", false);
                    }, 'giveUpEnableSeconds' in getParams ? parseInt(getParams['giveUpEnableSeconds']) * 1000 : 30000);

                    // Starting point for unity
                    initGame(window.game_url);
                    if ("onpointerlockchange" in document) {
                      document.addEventListener('pointerlockchange', lockChangeAlert, false);
                    } else if ("onmozpointerlockchange" in document) {
                      document.addEventListener('mozpointerlockchange', lockChangeAlert, false);
                    }

                    function lockChangeAlert() {
                      if (document.pointerLockElement === null) {
                        gameInstance.SendMessage('FPSController', 'DisableMouseControl');
                      }
                    }
             });
          }
        })
        .fail(function( jqxhr, settings, exception ) {
          console.error( "Triggered ajaxError handler.", exception);
      });
    }
  );
});
