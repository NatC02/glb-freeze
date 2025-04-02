import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Animation Control Configuration
 * Adjust these variables to control the animation behavior
 */
const CONFIG = {
  // Time at which to freeze the animation (in seconds)
  FREEZE_TIME: .5,
  
  // Path to your GLB model
  MODEL_PATH: '/frog.glb',
  
  // Show animation time in console for debugging
  DEBUG: true
};

/**
 * Base Setup
 */
// Canvas
const canvas = document.querySelector('canvas.webgl') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff); // White background

// Sizes
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
};

// Camera
const camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height, 0.1, 100);
camera.position.set(0, 1, 3);
scene.add(camera);

// Controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 1, 0);

// Renderer
const renderer = new THREE.WebGLRenderer({ 
  canvas,
  antialias: true 
});
renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// Add lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

/**
 * Animation Control Variables
 */
let mixer: THREE.AnimationMixer | null = null;
let model: THREE.Group | null = null;
let animations: THREE.AnimationClip[] = [];
let isPlaying: boolean = false;
let isFrozen: boolean = false;
let actionState: 'idle' | 'playing' | 'frozen' = 'idle';

/**
 * Animation Time Controller
 * Controls precise animation timing and freezing
 */
class AnimationTimeController {
  private mixer: THREE.AnimationMixer;
  private animations: THREE.AnimationClip[];
  private isMonitoring: boolean = false;
  private targetTime: number | null = null;
  private rafId: number | null = null;
  private modelGroup: THREE.Group;
  private animationStartTime: number = 0;

  constructor(mixer: THREE.AnimationMixer, animations: THREE.AnimationClip[], modelGroup: THREE.Group) {
    this.mixer = mixer;
    this.animations = animations;
    this.modelGroup = modelGroup;
  }

  // Play animation from start
  playAnimation(): void {
    this.stopMonitoring();
    
    // Reset animation state
    this.mixer.stopAllAction();
    
    // Reset and play all animations
    this.animations.forEach(clip => {
      const action = this.mixer.clipAction(clip);
      action.reset();
      action.play();
    });
    
    // Mark animation as playing
    isPlaying = true;
    isFrozen = false;
    actionState = 'playing';
    this.animationStartTime = Date.now();
    
    if (CONFIG.DEBUG) {
      console.log('Animation started');
    }
  }
  
  // Monitor animation to freeze at the target time
  monitorAndFreezeAt(targetTime: number): void {
    if (!this.mixer) return;
    
    this.targetTime = targetTime;
    this.isMonitoring = true;
    
    // Start monitoring if not already running
    if (!this.rafId) {
      this.checkFrame();
    }
    
    if (CONFIG.DEBUG) {
      console.log(`Monitoring animation to freeze at ${targetTime}s`);
    }
  }
  
  // Frame check - runs on each animation frame
  private checkFrame(): void {
    if (!this.isMonitoring) {
      this.rafId = null;
      return;
    }
    
    // Get current time of animation
    const action = this.mixer.existingAction(this.animations[0]);
    const currentTime = action ? action.time : 0;
    
    if (CONFIG.DEBUG && Date.now() % 500 < 20) { // Log roughly every 500ms
      console.log(`Current time: ${currentTime.toFixed(2)}s`);
    }
    
    // If we've reached or passed the target time
    if (this.targetTime !== null && currentTime >= this.targetTime) {
      // Force animation to exact target time
      this.animations.forEach(clip => {
        const action = this.mixer.existingAction(clip);
        if (action) {
          action.time = this.targetTime as number;
          // Update mixer once to apply exact time
          this.mixer.update(0);
          // Then pause the action
          action.paused = true;
          action.enabled = false; // Fully disable the action
        }
      });
      
      // Take a snapshot of the current state to ensure nothing moves
      this.takeModelSnapshot();
      
      // Set state flags
      isPlaying = false;
      isFrozen = true;
      actionState = 'frozen';
      
      if (CONFIG.DEBUG) {
        console.log(`Animation frozen at exactly ${this.targetTime}s`);
        console.log(`Total animation time: ${(Date.now() - this.animationStartTime) / 1000}s`);
      }
      
      // Stop monitoring
      this.stopMonitoring();
      return;
    }
    
    // Continue checking on next frame
    this.rafId = requestAnimationFrame(() => this.checkFrame());
  }
  
  // Stop monitoring animation frames
  stopMonitoring(): void {
    this.isMonitoring = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
  
  // Snapshot of model to guarantee position
  private takeModelSnapshot(): void {
    // Store current transforms of all objects
    const snapshot: Map<string, {
      position: THREE.Vector3,
      quaternion: THREE.Quaternion,
      scale: THREE.Vector3
    }> = new Map();
    
    this.modelGroup.traverse((obj) => {
      if (obj.isObject3D) {
        snapshot.set(obj.uuid, {
          position: obj.position.clone(),
          quaternion: obj.quaternion.clone(),
          scale: obj.scale.clone()
        });
      }
    });
    
    // Force exact position on every frame
    const enforceSnapshot = () => {
      if (!isFrozen) return;
      
      this.modelGroup.traverse((obj) => {
        const data = snapshot.get(obj.uuid);
        if (data) {
          obj.position.copy(data.position);
          obj.quaternion.copy(data.quaternion);
          obj.scale.copy(data.scale);
        }
      });
      
      // Keep enforcing if still frozen
      if (isFrozen) {
        requestAnimationFrame(enforceSnapshot);
      }
    };
    
    // Start enforcing
    enforceSnapshot();
  }
}

let animationController: AnimationTimeController | null = null;

/**
 * Raycasting for Model Click Detection
 */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Handle mouse click
window.addEventListener('click', (event) => {
  // Calculate normalized mouse coordinates
  mouse.x = (event.clientX / sizes.width) * 2 - 1;
  mouse.y = -(event.clientY / sizes.height) * 2 + 1;
  
  // Set up raycaster
  raycaster.setFromCamera(mouse, camera);
  
  // Check for intersections with the model
  if (model) {
    const intersects = raycaster.intersectObject(model, true);
    
    if (intersects.length > 0) {
      handleModelClick();
    }
  }
});

// Handle model click
function handleModelClick(): void {
  if (!animationController || !mixer || animations.length === 0) {
    return;
  }
  
  if (actionState === 'idle') {
    // Start animation and monitor for freeze time
    animationController.playAnimation();
    animationController.monitorAndFreezeAt(CONFIG.FREEZE_TIME);
  } else if (actionState === 'frozen') {
    // Reset to idle state if already frozen
    mixer.stopAllAction();
    actionState = 'idle';
    isPlaying = false;
    isFrozen = false;
    
    if (CONFIG.DEBUG) {
      console.log('Animation reset to idle state');
    }
  }
  // Do nothing if already playing - let it reach the freeze point
}

/**
 * GLB Model Loading
 */
const loader = new GLTFLoader();
const loadingInfo = document.createElement('div');
loadingInfo.className = 'info';
loadingInfo.textContent = 'Loading model...';
document.body.appendChild(loadingInfo);

// Load GLB model
loader.load(
  CONFIG.MODEL_PATH, 
  (gltf) => {
    if (CONFIG.DEBUG) {
      console.log('GLB model loaded:', gltf);
    }
    
    // Add model to scene
    model = gltf.scene;
    scene.add(model);
    
    // Center model
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    // Position model at origin
    model.position.x = -center.x;
    model.position.y = -center.y;
    model.position.z = -center.z;
    
    // Adjust camera position based on model size
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    
    // Set camera to view the whole model
    cameraZ *= 1.5; // Add some margin
    camera.position.z = cameraZ;
    camera.updateProjectionMatrix();
    controls.target.set(0, size.y / 2, 0);
    controls.update();
    
    // Setup animations
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      animations = gltf.animations;
      
      // Create animation controller
      animationController = new AnimationTimeController(mixer, animations, model);
      
      // Update info text
      loadingInfo.textContent = 'Click on the model to play and freeze its animation.';
      
      if (CONFIG.DEBUG) {
        console.log(`Loaded ${animations.length} animations:`);
        animations.forEach((clip, index) => {
          console.log(`Animation ${index}: "${clip.name}" - Duration: ${clip.duration.toFixed(2)}s`);
        });
      }
    } else {
      loadingInfo.textContent = 'Model loaded, but no animations were found.';
      console.warn('No animations found in the model');
    }
  }, 
  // Progress callback
  (xhr) => {
    const percent = Math.floor((xhr.loaded / xhr.total) * 100);
    loadingInfo.textContent = `Loading model: ${percent}%`;
  },
  // Error callback
  (error) => {
    console.error('Error loading GLB model:', error);
    loadingInfo.textContent = 'Error loading model. Check console for details.';
  }
);

/**
 * Resize Handling
 */
window.addEventListener('resize', () => {
  // Update sizes
  sizes.width = window.innerWidth;
  sizes.height = window.innerHeight;

  // Update camera
  camera.aspect = sizes.width / sizes.height;
  camera.updateProjectionMatrix();

  // Update renderer
  renderer.setSize(sizes.width, sizes.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/**
 * Animation Loop
 */
const clock = new THREE.Clock();

const tick = (): void => {
  // Update controls
  controls.update();

  // Update mixer if animation is playing
  if (mixer && isPlaying && !isFrozen) {
    mixer.update(clock.getDelta());
  }

  // Render
  renderer.render(scene, camera);

  // Call tick again on the next frame
  window.requestAnimationFrame(tick);
};

tick();