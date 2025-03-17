import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import * as moment from 'moment';

interface CanvasAssignmentProcessorSettings {
	canvasToken: string;
	canvasApiBase: string;
	templatePath: string;
	semester: string;
	year: string;
}
declare global {
	interface Window {
		moment: any;
	}
  }
  
// Interface for Canvas assignment data
interface CanvasAssignment {
	id: number;
	name: string;
	description: string;
	html_url: string;
	points_possible: number;
	due_at: string | null;
	course_code: string;
	course_name: string;
	course: string;
}

// Interface for Canvas course data
interface CanvasCourse {
	id: number;
	name: string;
	course_code: string;
	term?: {
		name: string;
	};
}

const DEFAULT_SETTINGS: CanvasAssignmentProcessorSettings = {
	canvasToken: '',
	canvasApiBase: 'https://canvas.instructure.com/api/v1',
	templatePath: 'Templates/Assignment.md',
	semester: 'Spring',
	year: '2025'
}

export default class CanvasAssignmentProcessor extends Plugin {
	settings: CanvasAssignmentProcessorSettings;
	statusBarItemEl: HTMLElement;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('download', 'Fetch Canvas Assignments', (evt: MouseEvent) => {
			this.createAssignmentNotes();
		});
		
		ribbonIconEl.addClass('canvas-assignments-ribbon-class');

		// This adds a status bar item showing the current semester and year
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		// This adds a command to fetch Canvas assignments
		this.addCommand({
			id: 'fetch-canvas-assignments',
			name: 'Fetch Canvas Assignments',
			callback: () => {
				this.createAssignmentNotes();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CanvasAssignmentProcessorSettingTab(this.app, this));
	}

	updateStatusBar() {
		this.statusBarItemEl.setText(`Canvas: ${this.settings.semester} ${this.settings.year}`);
	}

	onunload() {
		// Clean up when the plugin is disabled
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateStatusBar();
	}

	// Canvas Assignment Processor functionality
	async makeRequest<T>(url: string): Promise<T> {
		try {
			console.log(`Making request to: ${url}`);
			
			// Use Obsidian's requestUrl API instead of fetch
			const response = await requestUrl({
				url: url,
				method: "GET",
				headers: {
					'Authorization': `Bearer ${this.settings.canvasToken}`,
					'Accept': 'application/json'
				}
			});
			
			console.log(`Response received. Status: ${response.status}`);
			return response.json as T;
		} catch (error) {
			console.error(`Error in makeRequest for ${url}:`, error);
			throw error;
		}
	}

	async getAllPages<T>(baseUrl: string): Promise<T[]> {
		let allData: T[] = [];
		let page = 1;
		let hasMore = true;
		
		while (hasMore) {
			const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${page}&per_page=100`;
			console.log(`Fetching page ${page}: ${url}`);
			
			try {
				const data = await this.makeRequest<T[]>(url);
				
				if (Array.isArray(data) && data.length > 0) {
					console.log(`Received ${data.length} items on page ${page}`);
					allData = [...allData, ...data];
					page++;
				} else {
					console.log(`No more data received on page ${page}`);
					hasMore = false;
				}
				
				if (Array.isArray(data) && data.length < 100) {
					console.log('Received less than 100 items, ending pagination');
					hasMore = false;
				}
			} catch (error) {
				console.error(`Error fetching page ${page}:`, error);
				hasMore = false;
			}
		}
		
		return allData;
	}

	async loadProcessedAssignments(): Promise<Record<string, string>> {
		const PROCESSED_ASSIGNMENTS_PATH = 'processed_assignments.json';
		
		try {
			if (await this.app.vault.adapter.exists(PROCESSED_ASSIGNMENTS_PATH)) {
				const content = await this.app.vault.adapter.read(PROCESSED_ASSIGNMENTS_PATH);
				return JSON.parse(content);
			}
			return {};
		} catch (error) {
			console.error('Error loading processed assignments:', error);
			return {};
		}
	}

	async saveProcessedAssignments(processedAssignments: Record<string, string>) {
		const PROCESSED_ASSIGNMENTS_PATH = 'processed_assignments.json';
		
		try {
			await this.app.vault.adapter.write(
				PROCESSED_ASSIGNMENTS_PATH,
				JSON.stringify(processedAssignments, null, 2)
			);
		} catch (error) {
			console.error('Error saving processed assignments:', error);
		}
	}

	findExistingAssignmentFile(directoryPath: string, cleanedName: string): TFile | null {
		try {
			// Get all files in the directory
			const files = this.app.vault.getMarkdownFiles()
				.filter(file => file.path.startsWith(directoryPath));
			
			// Look for a file that contains the cleaned name
			return files.find(file => {
				const fileCleanedName = this.cleanAssignmentName(file.basename);
				return fileCleanedName === cleanedName;
			}) || null;
		} catch (error) {
			console.error('Error finding existing assignment:', error);
			return null;
		}
	}

	getAssignmentHash(assignment: CanvasAssignment): string {
		const relevantData = {
			name: assignment.name,
			description: assignment.description,
			points_possible: assignment.points_possible,
			html_url: assignment.html_url
		};
		return JSON.stringify(relevantData);
	}

	async updateDueDate(existingFile: TFile, newDueDate: string): Promise<boolean> {
		try {
			const content = await this.app.vault.read(existingFile);
			
			let updatedContent = content.replace(
				/duedate: .*$/m,
				`duedate: ${newDueDate}`
			);
			
			const formattedDate = newDueDate ? 
				moment(newDueDate).format('MMMM Do YYYY') :
				'No Due Date';
				
			updatedContent = updatedContent.replace(
				/Due Date: .*$/m,
				`Due Date: ${formattedDate}`
			);
			
			await this.app.vault.modify(existingFile, updatedContent);
			return true;
		} catch (error) {
			console.error('Error updating due date:', error);
			return false;
		}
	}

	isCurrentSemesterCourse(course: CanvasCourse): boolean {
		const courseName = course.name ? course.name.toLowerCase() : '';
		const courseCode = course.course_code ? course.course_code.toLowerCase() : '';
		const termName = course.term?.name ? course.term.name.toLowerCase() : '';
		
		const semesterYear = `${this.settings.semester.toLowerCase()} ${this.settings.year}`;
		
		return (courseName.includes(semesterYear) || 
				courseCode.includes(`${this.settings.year}${this.settings.semester.toLowerCase()}`) || 
				courseCode.includes(`${this.settings.year}${this.settings.semester.toLowerCase()}c`) ||
				(courseCode.includes(this.settings.semester.toLowerCase()) && courseCode.includes(this.settings.year)) ||
				termName.includes(`${this.settings.year} ${this.settings.semester.toLowerCase()}`));
	}

	async fetchCanvasAssignments(): Promise<CanvasAssignment[]> {
		console.log('Fetching all courses...');
		const courses = await this.getAllPages<CanvasCourse>(
			`${this.settings.canvasApiBase}/courses?include[]=term&enrollment_state=active`
		);
		
		const currentSemesterCourses = courses.filter(course => this.isCurrentSemesterCourse(course));
		console.log(`Found ${currentSemesterCourses.length} ${this.settings.semester} ${this.settings.year} courses`);
		
		let allAssignments: CanvasAssignment[] = [];
		for (const course of currentSemesterCourses) {
			try {
				console.log(`Fetching assignments for course ${course.id} (${course.name})`);
				
				const assignments = await this.getAllPages<Partial<CanvasAssignment>>(
					`${this.settings.canvasApiBase}/courses/${course.id}/assignments?include[]=submission`
				);
				
				console.log(`Retrieved ${assignments.length} assignments for course ${course.id}`);
				
				const processedAssignments: CanvasAssignment[] = assignments.map(assignment => {
					const courseCodeMatch = course.course_code.match(/([A-Z]{3}[0-9]{3})/);
					return {
						...assignment as CanvasAssignment,
						course_code: course.course_code,
						course_name: course.name,
						course: courseCodeMatch ? courseCodeMatch[1] : course.course_code
					};
				});
				
				allAssignments = [...allAssignments, ...processedAssignments];
			} catch (err) {
				console.error(`Error fetching assignments for course ${course.id}:`, err);
				continue;
			}
		}
		
		return allAssignments;
	}

	cleanAssignmentName(name: string): string {
		name = name.replace(/\[.*?\]/g, '');
		name = name.replace(/-[A-Z]{3}[0-9]{3}-/g, '');
		name = name.replace(/\d{4}-\d{2}-\d{2}/, '');
		name = name.replace(/[\*"\\/<>:|?]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		return name;
	}

	async createAssignmentNotes(): Promise<void> {
		// Check if the Templater plugin is available
		// @ts-ignore - Accessing plugin that may not be typed
		const templater = this.app.plugins.plugins["templater-obsidian"];
		
		if (!templater) {
			new Notice("Templater plugin not found! Please install and enable it.");
			return;
		}

		try {
			new Notice(`Fetching Canvas assignments for ${this.settings.semester} ${this.settings.year}...`);
			
			const processedAssignments = await this.loadProcessedAssignments();
			const assignments = await this.fetchCanvasAssignments();
			let createdCount = 0;
			let updatedCount = 0;
			let dueDateUpdatedCount = 0;
			let skippedCount = 0;
			
			for (const assignment of assignments) {
				const courseCode = assignment.course;
				const semester = `${this.settings.semester} ${this.settings.year}`;
				// Path to include Assignments folder
				const directoryPath = `${semester}/${courseCode}/Assignments`;
				
				const cleanedName = this.cleanAssignmentName(assignment.name);
				const formattedDate = assignment.due_at 
					? window.moment(assignment.due_at).format('YYYY-MM-DD')
					: '';
				
				const formattedTitle = `${cleanedName} [Assignment] [-${courseCode}-] ${formattedDate}`;
				const newNotePath = `${directoryPath}/${formattedTitle}.md`;
				
				const assignmentKey = `${courseCode}-${cleanedName}`.toLowerCase();
				const currentHash = this.getAssignmentHash(assignment);
				
				// Create directory structure including Assignments folder
				try {
					if (!await this.app.vault.adapter.exists(semester)) {
						await this.app.vault.createFolder(semester);
					}
					if (!await this.app.vault.adapter.exists(`${semester}/${courseCode}`)) {
						await this.app.vault.createFolder(`${semester}/${courseCode}`);
					}
					if (!await this.app.vault.adapter.exists(directoryPath)) {
						await this.app.vault.createFolder(directoryPath);
					}
				} catch (err) {
					console.error(`Error creating directories for ${courseCode}:`, err);
					continue;
				}
				
				const existingFile = this.findExistingAssignmentFile(directoryPath, cleanedName);
				const previousHash = processedAssignments[assignmentKey];
				
				if (!existingFile) {
					try {
						const templateFile = this.app.vault.getAbstractFileByPath(this.settings.templatePath);
						if (!templateFile) {
							throw new Error(`Template file not found at ${this.settings.templatePath}!`);
						}

						const templateContent = await this.app.vault.read(templateFile as TFile);
						let enrichedContent = templateContent + `\n\n## Assignment Details\n`;
						enrichedContent += `Points: ${assignment.points_possible}\n`;
						if (assignment.description) {
							enrichedContent += `\n### Description\n${assignment.description}\n`;
						}
						if (assignment.html_url) {
							enrichedContent += `\n[View on Canvas](${assignment.html_url})\n`;
						}

						const file = await this.app.vault.create(newNotePath, enrichedContent);
						await templater.templater.overwrite_file_commands(file);
						
						createdCount++;
						console.log(`Created note for assignment: ${formattedTitle}`);
					} catch (err) {
						console.error(`Error creating note for ${formattedTitle}:`, err);
						continue;
					}
				} else {
					if (previousHash && previousHash !== currentHash) {
						try {
							const existingContent = await this.app.vault.read(existingFile);
							
							const updatedContent = existingContent.replace(
								/## Assignment Details[\s\S]*$/,
								`## Assignment Details\nPoints: ${assignment.points_possible}\n\n### Description\n${assignment.description || ''}\n\n[View on Canvas](${assignment.html_url})\n`
							);
							
							await this.app.vault.modify(existingFile, updatedContent);
							updatedCount++;
							console.log(`Updated note: ${existingFile.basename}`);
						} catch (err) {
							console.error(`Error updating note: ${existingFile.basename}`, err);
							continue;
						}
					}
					
					const fileContent = await this.app.vault.read(existingFile);
					const currentDueDateMatch = fileContent.match(/duedate: (.*?)(\n|$)/);
					const currentDueDate = currentDueDateMatch ? currentDueDateMatch[1].trim() : '';
					
					if (currentDueDate !== formattedDate) {
						const updated = await this.updateDueDate(existingFile, formattedDate);
						if (updated) {
							dueDateUpdatedCount++;
							console.log(`Updated due date for: ${existingFile.basename}`);
						}
					} else {
						skippedCount++;
						console.log(`Skipped existing note: ${existingFile.basename}`);
					}
				}
				
				processedAssignments[assignmentKey] = currentHash;
			}
			
			await this.saveProcessedAssignments(processedAssignments);
			
			new Notice(`Created ${createdCount} new notes, updated ${updatedCount}, updated ${dueDateUpdatedCount} due dates, skipped ${skippedCount} unchanged notes`);
			
		} catch (error) {
			console.error('Error processing assignments:', error);
			new Notice(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

class CanvasAssignmentProcessorSettingTab extends PluginSettingTab {
	plugin: CanvasAssignmentProcessor;

	constructor(app: App, plugin: CanvasAssignmentProcessor) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'Canvas Assignment Processor Settings'});

		new Setting(containerEl)
			.setName('Canvas API Token')
			.setDesc('Your Canvas API token (keep this secure)')
			.addText(text => text
				.setPlaceholder('Enter your Canvas API token')
				.setValue(this.plugin.settings.canvasToken)
				.onChange(async (value) => {
					this.plugin.settings.canvasToken = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Canvas API Base URL')
			.setDesc('The base URL for your Canvas instance API (e.g., https://yourschool.instructure.com/api/v1)')
			.addText(text => text
				.setPlaceholder('Enter Canvas API base URL')
				.setValue(this.plugin.settings.canvasApiBase)
				.onChange(async (value) => {
					this.plugin.settings.canvasApiBase = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Assignment Template Path')
			.setDesc('Path to the template file for assignments')
			.addText(text => text
				.setPlaceholder('Templates/Assignment.md')
				.setValue(this.plugin.settings.templatePath)
				.onChange(async (value) => {
					this.plugin.settings.templatePath = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Semester')
			.setDesc('Current semester (e.g., Spring, Fall, Summer)')
			.addText(text => text
				.setPlaceholder('Spring')
				.setValue(this.plugin.settings.semester)
				.onChange(async (value) => {
					this.plugin.settings.semester = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Year')
			.setDesc('Current year')
			.addText(text => text
				.setPlaceholder('2025')
				.setValue(this.plugin.settings.year)
				.onChange(async (value) => {
					this.plugin.settings.year = value;
					await this.plugin.saveSettings();
				}));
	}
}
