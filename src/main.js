const $ = (id) => document.getElementById(id);

const sceneMount = $("sceneMount");
const hudMessage = $("hudMessage");
const modelControls = $("modelControls");

let activeScene = null;
let started = false;
let activeModelControl = null;
const animationMixers = [];

// Register A-Frame component to update animation mixers on every render frame
if (typeof window !== "undefined" && window.AFRAME && !window.AFRAME.components["model-animator"]) {
  window.AFRAME.registerComponent("model-animator", {
    init: function () {
      this.clock = new (window.AFRAME.THREE || window.THREE).Clock();
    },
    tick: function (_time, delta) {
      const dt = delta ? Math.min(delta / 1000, 0.05) : (this.clock ? Math.min(this.clock.getDelta(), 0.05) : 0.016);
      if (dt > 0) {
        for (let i = 0; i < animationMixers.length; i++) {
          const item = animationMixers[i];
          if (item?.mixer) item.mixer.update(dt);
        }
      }
    }
  });
}

function computeLocalBoundingBox(object) {
  const THREE = window.AFRAME?.THREE || window.THREE;
  if (!THREE || !object) return null;

  const box = new THREE.Box3();
  box.makeEmpty();

  // Compute bounding box strictly in model's local coordinate space,
  // immune to scene, camera, or anchor world-space transforms.
  object.updateMatrixWorld(true);
  const inverseRoot = object.matrixWorld.clone().invert();

  object.traverse((child) => {
    if (child.isMesh && child.geometry) {
      if (!child.geometry.boundingBox) {
        child.geometry.computeBoundingBox();
      }
      if (child.geometry.boundingBox) {
        const geomBox = child.geometry.boundingBox.clone();
        child.updateMatrixWorld(true);
        const childToRoot = child.matrixWorld.clone().premultiply(inverseRoot);
        geomBox.applyMatrix4(childToRoot);
        box.union(geomBox);
      }
    }
  });

  return box.isEmpty() ? null : box;
}

function showMessage(message) {
  if (hudMessage) hudMessage.textContent = message;
}

async function loadManifest() {
  const response = await fetch("./config/targets.json", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Cannot load ./config/targets.json. Run npm run manifest.");
  }

  const manifest = await response.json();

  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error("No image/model pairs found. Check public/targets and public/3d.");
  }

  return manifest;
}

function addLight(scene, type, color, intensity, position) {
  const light = document.createElement("a-entity");
  light.setAttribute("light", { type, color, intensity });
  if (position) light.setAttribute("position", position);
  scene.appendChild(light);
}

function makeScene(manifest) {
  animationMixers.length = 0;
  const scene = document.createElement("a-scene");
  scene.setAttribute("model-animator", "");

  scene.setAttribute("mindar-image", [
    "imageTargetSrc: ./targets/targets.mind",
    "autoStart: false",
    "uiScanning: false",
    "uiLoading: false",
    `filterMinCF: ${manifest.tracking?.filterMinCF ?? 0.001}`,
    `filterBeta: ${manifest.tracking?.filterBeta ?? 10}`
  ].join("; ") + ";");

  scene.setAttribute("embedded", "");
  scene.setAttribute("color-space", "sRGB");
  scene.setAttribute("renderer", "alpha: true; antialias: true; colorManagement: true");
  scene.setAttribute("vr-mode-ui", "enabled: false");
  scene.setAttribute("device-orientation-permission-ui", "enabled: false");
  scene.setAttribute("loading-screen", "enabled: false");

  const assets = document.createElement("a-assets");
  assets.setAttribute("timeout", "30000");

  manifest.targets.forEach((target, index) => {
    const asset = document.createElement("a-asset-item");
    asset.id = `model-${index}`;
    asset.setAttribute("src", target.modelUrl);
    assets.appendChild(asset);
  });

  scene.appendChild(assets);

  // Even fill lighting for virtual models. Lighting does not brighten the real camera feed.
  addLight(scene, "ambient", "#ffffff", 0.8);
  addLight(scene, "hemisphere", "#ffffff", 1.1);
  addLight(scene, "directional", "#ffffff", 0.45, "0 3 4");
  addLight(scene, "directional", "#ffffff", 0.35, "-4 1 1");
  addLight(scene, "directional", "#ffffff", 0.35, "4 1 -3");

  manifest.targets.forEach((target, index) => {
    const anchor = document.createElement("a-entity");
    anchor.setAttribute("mindar-image-target", `targetIndex: ${target.targetIndex}`);

    // Transform controls affect this child only; MindAR remains in control of the anchor pose.
    const modelRoot = document.createElement("a-entity");
    modelRoot.setAttribute("position", target.position || "0 0 0");
    const userRotation = (target.rotation || "0 0 0").trim().split(/[ ,]+/).map(Number);
    // MindAR's target plane is XY. For a floor image, the GLB's Y-up axis
    // must point along the target plane normal. Geometry is bottom-aligned
    // after loading so the model rests on the image instead of floating.
    const surfaceRotation = target.surface === "floor" ? [90, 0, 0] : [0, 0, 0];
    const combinedRotation = userRotation.map((value, axis) => value + surfaceRotation[axis]);
    modelRoot.setAttribute("rotation", combinedRotation.join(" "));
    modelRoot.setAttribute("scale", target.scale || "0.2 0.2 0.2");
    const model = document.createElement("a-gltf-model");
    model.setAttribute("src", `#model-${index}`);
    model.setAttribute("position", "0 0 0");
    model.setAttribute("rotation", "0 0 0");
    model.setAttribute("scale", "1 1 1");
    model.setAttribute("visible", "false");

    modelRoot.appendChild(model);
    anchor.appendChild(modelRoot);

    let mixer = null;
    let clips = [];
    let isPlaying = true;
    model.addEventListener("model-loaded", (evt) => {
      const object = model.getObject3D("mesh");
      if (!object) return;

      // Extract clips from all possible glTF locations
      let foundClips = object.animations || [];
      if (!foundClips.length && model.components?.["gltf-model"]?.model?.animations) {
        foundClips = model.components["gltf-model"].model.animations;
      }
      if (!foundClips.length && evt?.detail?.model?.animations) {
        foundClips = evt.detail.model.animations;
      }
      if (!foundClips.length) {
        object.traverse((child) => {
          if (child.animations?.length && !foundClips.length) {
            foundClips = child.animations;
          }
        });
      }
      clips = foundClips;

      // Align model relative to the target plane so it rests firmly on the surface
      // without floating or levitating in the air.
      const localBox = computeLocalBoundingBox(object);
      if (localBox) {
        if (target.surface === "floor") {
          // For a floor/horizontal surface, modelRoot is rotated 90 deg on X,
          // so local Y is normal to the surface (+Z of the anchor).
          // Aligning the lowest point of the model (min.y) to 0 ensures
          // the model's base sits flush on the target plane with zero levitation.
          if (Number.isFinite(localBox.min.y)) {
            model.object3D.position.y = -localBox.min.y;
            model.object3D.updateMatrix();
          }
        } else {
          // For a wall/vertical surface, align model's back (min.z) flush to the target plane (Z = 0)
          if (Number.isFinite(localBox.min.z)) {
            model.object3D.position.z = -localBox.min.z;
            model.object3D.updateMatrix();
          }
        }
      }

      if (clips.length && (window.AFRAME?.THREE || window.THREE)?.AnimationMixer) {
        const THREE_LIB = window.AFRAME?.THREE || window.THREE;
        mixer = new THREE_LIB.AnimationMixer(object);
        clips.forEach((clip) => {
          const action = mixer.clipAction(clip);
          action.setLoop(THREE_LIB.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          action.enable = true;
          action.play();
        });
        mixer.timeScale = isPlaying ? 1 : 0;
        animationMixers.push({ mixer, modelRoot });
      }
      if (activeModelControl?.root === modelRoot) {
        activeModelControl.mixer = mixer;
      }
      refreshAnimationButton();
    });

    const original = {
      rotation: combinedRotation,
      scale: (target.scale || "0.2 0.2 0.2").trim().split(/[ ,]+/).map(Number),
      position: (target.position || "0 0 0").trim().split(/[ ,]+/).map(Number)
    };

    function refreshAnimationButton() {
      const button = modelControls?.querySelector('[data-action="animation"]');
      if (!button || activeModelControl?.root !== modelRoot) return;
      button.hidden = !clips.length;
      button.textContent = isPlaying ? "Pause" : "Play";
      button.setAttribute("aria-label", isPlaying ? "Pause animation" : "Play animation");
      button.classList.toggle("is-playing", isPlaying);
    }

    anchor.addEventListener("targetFound", () => {
      model.setAttribute("visible", "true");
      if (mixer) mixer.timeScale = isPlaying ? 1 : 0;
      activeModelControl = { root: modelRoot, original, mixer, get clips() { return clips; }, get isPlaying() { return isPlaying; }, setPlaying(value) {
        isPlaying = value;
        if (mixer) mixer.timeScale = value ? 1 : 0;
        refreshAnimationButton();
      } };
      modelControls?.classList.remove("hidden");
      refreshAnimationButton();
      $("arShell")?.classList.add("target-found");
      showMessage(`${target.name} found`);
    });

    anchor.addEventListener("targetLost", () => {
      model.setAttribute("visible", "false");
      if (activeModelControl?.root === modelRoot) {
        activeModelControl = null;
        modelControls?.classList.add("hidden");
      }
      $("arShell")?.classList.remove("target-found");
      showMessage("Scan target image");
    });

    scene.appendChild(anchor);
  });

  // Animation updates are driven by the 'model-animator' component attached to the scene.

  const camera = document.createElement("a-camera");
  camera.setAttribute("position", "0 0 0");
  camera.setAttribute("look-controls", "enabled: false");
  scene.appendChild(camera);

  scene.addEventListener("loaded", async () => {
    try {
      const mindar = scene.systems["mindar-image-system"];
      if (!mindar) throw new Error("MindAR failed to initialize.");
      await mindar.start();
      showMessage("Scan target image");
    } catch (error) {
      showMessage(`Camera error: ${error.message || error}`);
      console.error("AR startup failed:", error);
    }
  }, { once: true });

  return scene;
}

function adjustModel(action) {
  if (!activeModelControl) return;

  const { root, original } = activeModelControl;
  if (action === "animation") {
    if (!activeModelControl.clips?.length) {
      showMessage("This model has no embedded animation");
      return;
    }
    activeModelControl.setPlaying(!activeModelControl.isPlaying);
    showMessage(activeModelControl.isPlaying ? "Animation playing" : "Animation paused");
    return;
  }
  const rotation = root.getAttribute("rotation");
  const scale = root.getAttribute("scale");

  if (action === "rotate-left") {
    root.setAttribute("rotation", {
      x: rotation.x,
      y: rotation.y - 15,
      z: rotation.z
    });
  } else if (action === "rotate-right") {
    root.setAttribute("rotation", {
      x: rotation.x,
      y: rotation.y + 15,
      z: rotation.z
    });
  } else if (action === "zoom-in" || action === "zoom-out") {
    const factor = action === "zoom-in" ? 1.12 : 1 / 1.12;
    const next = Math.max(0.02, Math.min(5, scale.x * factor));
    root.setAttribute("scale", { x: next, y: next, z: next });
  } else if (action === "reset") {
    root.setAttribute("rotation", {
      x: original.rotation[0] || 0,
      y: original.rotation[1] || 0,
      z: original.rotation[2] || 0
    });
    root.setAttribute("position", {
      x: original.position[0] || 0,
      y: original.position[1] || 0,
      z: original.position[2] || 0
    });
    root.setAttribute("scale", {
      x: original.scale[0] || 0.2,
      y: original.scale[1] || 0.2,
      z: original.scale[2] || 0.2
    });
  }
}

modelControls?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) adjustModel(button.dataset.action);
});

async function startAR() {
  if (started) return;
  started = true;

  try {
    if (!sceneMount) throw new Error("Missing #sceneMount in index.html.");

    const manifest = await loadManifest();
    sceneMount.innerHTML = "";
    activeScene = makeScene(manifest);
    sceneMount.appendChild(activeScene);
  } catch (error) {
    started = false;
    showMessage(error.message || String(error));
    console.error("AR setup failed:", error);
  }
}

startAR();
